// Phase 4/5 (specs/computer-use.md "Protected foreground grant", "Generation fencing"):
// the runtime owns the ProtectedForegroundGrant binding; native Helper leases are per connection
// generation, never carried by the model, and never resurrected across generations.
//
// Run: node --test packages/zcode-cua/test/protected-grant.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { createComputerUseRuntime } from "../index.js";

const REQUIREMENT = 'identifier "dev.acevra.cua-helper" and anchor apple generic';
const IDENTITY = Object.freeze({
  verified: true,
  identifier: "dev.acevra.cua-helper",
  cd_hash: "abcd1234",
  ad_hoc: false,
  pid: 4242,
  bundle_validated: true,
  reason: "",
  requirement: REQUIREMENT,
});
const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});
const BOUNDS = Object.freeze({ x: 10, y: 20, w: 800, h: 600 });

/**
 * A fake Helper behind a relay that stamps `connection_generation` the way host-transport.js does.
 * `restart()` models a new Helper generation: every lease issued before it is unknown afterwards.
 */
function fakeHelper() {
  const state = {
    generation: 1,
    leaseSeq: 0,
    observationSeq: 0,
    leases: new Map(), // lease id → generation
    expired: new Set(),
    calls: [],
    bounds: { ...BOUNDS },
    /** method → (params) => result | "drop" | "close-before-answer" */
    override: new Map(),
  };
  const fg = (operation, extra = {}) => ({
    operation,
    effect: "confirmed",
    route: "quartz_input",
    classification: "REQUIRES_FOREGROUND",
    mode: "EXCLUSIVE_FOREGROUND",
    input_delivery: "confirmed",
    application_effect: "confirmed",
    evidence: [],
    lease_state: "active",
    ...extra,
  });
  const refused = (code) => ({
    effect: "refused",
    code,
    route: "none",
    evidence: [],
    classification: "REQUIRES_FOREGROUND",
    input_delivery: "none",
    application_effect: "unknown",
    mode: "EXCLUSIVE_FOREGROUND",
    lease_state: "inactive",
  });
  const handlers = {
    observe: (params) => {
      state.observationSeq += 1;
      const id = `0000000${state.generation}-0000-4000-8000-${String(state.observationSeq).padStart(12, "0")}`;
      return {
        operation: "observe",
        effect: "confirmed",
        route: "ax",
        evidence: [],
        pid: params.pid,
        tree: { ok: true, observation_id: id.toUpperCase(), elements: [] },
        ...(params.window_id
          ? {
              foreground_geometry: {
                observation_id: id,
                target_pid: params.pid,
                target_window_id: params.window_id,
                window_bounds: { ...state.bounds },
              },
            }
          : {}),
      };
    },
    acquire_control: () => {
      state.leaseSeq += 1;
      const id = `aaaaaaa${state.generation}-0000-4000-8000-${String(state.leaseSeq).padStart(12, "0")}`;
      state.leases.set(id, state.generation);
      return fg("acquire_control", {
        lease_id: id,
        input_delivery: "none",
        application_effect: "unknown",
      });
    },
    release_control: (params) => {
      state.leases.delete(params.lease_id);
      return fg("release_control", {
        lease_id: params.lease_id,
        lease_state: "released",
        input_delivery: "none",
        application_effect: "unknown",
      });
    },
    control_status: (params) => ({
      effect: "confirmed",
      route: "none",
      evidence: [],
      lease_state: state.leases.get(params.lease_id) === state.generation ? "active" : "unknown",
    }),
    click: (params) => {
      if (state.expired.has(params.lease_id)) {
        state.expired.delete(params.lease_id);
        state.leases.delete(params.lease_id);
        return refused("lease_expired");
      }
      if (state.leases.get(params.lease_id) !== state.generation) return refused("invalid_lease");
      return fg("click", { lease_id: params.lease_id });
    },
  };
  handlers.key_press = (params) => {
    const result = handlers.click(params);
    return result.effect === "confirmed" ? { ...result, operation: "key_press" } : result;
  };

  const dir = mkdtempSync(join(tmpdir(), "cua-protected-"));
  const socketPath = join(dir, "h.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = "";
      state.calls.push({
        method: request.method,
        params: request.params ?? {},
        generation: state.generation,
      });
      const override = state.override.get(request.method);
      const outcome = override
        ? override(request.params ?? {})
        : handlers[request.method]?.(request.params ?? {});
      if (outcome === "drop") {
        // The Helper died with this request in flight: the relay answers helper_exited.
        socket.end(
          `${JSON.stringify({ ok: false, id: request.id, error: { message: "the helper connection is no longer available", code: "helper_exited", delivery: "unknown", connection_generation: state.generation } })}\n`,
        );
        return;
      }
      if (outcome === "absent") {
        // No Helper attached: the relay refuses without forwarding.
        socket.end(
          `${JSON.stringify({ ok: false, id: request.id, error: { message: "the helper connection is not available", code: "helper_disconnected", delivery: "not_sent", connection_generation: state.generation } })}\n`,
        );
        return;
      }
      const stamp = outcome?.__generation ?? state.generation;
      const result = {
        ...outcome,
        helper_identity: IDENTITY,
        connection_generation: stamp,
      };
      delete result.__generation;
      socket.end(`${JSON.stringify({ ok: true, id: request.id, result })}\n`);
    });
  });
  return {
    state,
    socketPath,
    start: () => new Promise((resolve) => server.listen(socketPath, resolve)),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        rmSync(dir, { recursive: true, force: true });
      }),
    restart() {
      state.generation += 1;
    },
    count: (method) => state.calls.filter((call) => call.method === method).length,
  };
}

/** Authority double: grant identity + expiry, Stop revocation, Helper recovery. */
function fakeAuthority(helper) {
  const record = {
    grant: {
      state: "granted",
      grantId: "grant-1",
      expiresAt: Date.now() + 60_000,
    },
    takeoverRequests: 0,
    begins: [],
    commits: [],
    releases: [],
    stops: 0,
    recoveries: 0,
    leaseSeq: 0,
  };
  return {
    record,
    revoke() {
      record.grant = { state: "none" };
    },
    expire() {
      record.grant = { state: "none", expired: true };
    },
    async admission() {
      return { paused: false };
    },
    async reportActivity() {
      return { accepted: true };
    },
    async requestTakeover() {
      record.takeoverRequests += 1;
      return { state: record.grant.state };
    },
    async takeoverStatus() {
      return { ...record.grant };
    },
    async beginAcquire(owner) {
      record.leaseSeq += 1;
      record.begins.push(owner);
      return { leaseId: `authority-${record.leaseSeq}`, state: "reserving" };
    },
    async commitAcquire(leaseId, helperLeaseId, requirement, generation) {
      record.commits.push({ leaseId, helperLeaseId, requirement, generation });
      return { generation: record.leaseSeq, state: "active" };
    },
    async release(leaseId, reason) {
      record.releases.push({ leaseId, reason });
      return { state: "released" };
    },
    async stop() {
      record.stops += 1;
      return { status: "released" };
    },
    async recoverHelper() {
      record.recoveries += 1;
      helper.state.override.delete("click");
      helper.state.override.delete("key_press");
      helper.state.override.delete("observe");
      return { connected: true, connectionGeneration: helper.state.generation };
    },
  };
}

describe("runtime-owned ProtectedForegroundGrant", () => {
  let helper;
  let authority;
  let cua;
  const helpers = [];

  beforeEach(async () => {
    helper = fakeHelper();
    helpers.push(helper);
    await helper.start();
    authority = fakeAuthority(helper);
    cua = createComputerUseRuntime({
      brokerSocketPath: helper.socketPath,
      platform: "darwin",
      allowForegroundControl: () => true,
      leaseAuthority: authority,
    });
  });
  after(async () => {
    for (const each of helpers) await each.stop();
  });

  async function observe() {
    const result = await cua.execute({
      toolName: "get_app_state",
      arguments: { pid: 4242, window_id: 501 },
      context: LOCAL,
    });
    return JSON.parse(result.content[0].text).foreground_geometry.observation_id;
  }
  async function acquire() {
    const observationId = await observe();
    const result = await cua.execute({
      toolName: "computer.acquire_control",
      arguments: { observation_id: observationId },
      context: LOCAL,
    });
    return { result, observationId };
  }
  const click = (observationId, extra = {}) =>
    cua.execute({
      toolName: "computer.click",
      arguments: {
        observation_id: observationId,
        point: { x: 100, y: 100 },
        ...extra,
      },
      context: LOCAL,
    });
  const lastCall = (method) => helper.state.calls.findLast((call) => call.method === method);

  it("the model never sees a native lease id; the runtime injects the current one", async () => {
    const { result, observationId } = await acquire();
    assert.equal(result.structuredContent.protectedForeground, "active");
    assert.equal(JSON.stringify(result).includes("aaaaaaa"), false, JSON.stringify(result));
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.effect, "confirmed");
    assert.equal(JSON.stringify(clicked).includes("aaaaaaa"), false);
    assert.equal(lastCall("click").params.lease_id, authority.record.commits[0].helperLeaseId);
    assert.equal(
      authority.record.commits[0].generation,
      1,
      "commit records the issuing generation",
    );
  });

  it("a stale model-supplied lease id is ignored", async () => {
    const { observationId } = await acquire();
    await click(observationId, {
      lease_id: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(lastCall("click").params.lease_id, authority.record.commits[0].helperLeaseId);
  });

  it("Helper restart: a NEW native lease is acquired under the same grant, with no second Allow", async () => {
    const { observationId } = await acquire();
    const firstLease = authority.record.commits[0].helperLeaseId;
    assert.equal(authority.record.takeoverRequests, 1);
    // Generation 2: the old Helper (and its lease) is gone; the relay has no Helper yet.
    helper.restart();
    helper.state.override.set("click", () => "absent");
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.effect, "confirmed", JSON.stringify(clicked));
    assert.equal(authority.record.recoveries, 1, "relaunch went through the lifecycle owner");
    assert.equal(authority.record.takeoverRequests, 1, "no second Allow card");
    assert.equal(authority.record.commits.length, 2);
    const secondLease = authority.record.commits[1].helperLeaseId;
    assert.notEqual(secondLease, firstLease, "the old lease is never resurrected");
    assert.equal(authority.record.commits[1].generation, 2);
    assert.equal(lastCall("click").params.lease_id, secondLease);
    assert.equal(lastCall("click").generation, 2);
    assert.ok(
      authority.record.releases.some((entry) => entry.reason !== "interrupted"),
      "the dead authority lease is released with a lifecycle reason (grant kept)",
    );
    assert.equal(clicked.structuredContent.protectedForeground, "active");
  });

  it("an action whose delivery is uncertain is never replayed", async () => {
    const { observationId } = await acquire();
    helper.state.override.set("click", () => "drop");
    const before = helper.count("click");
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.code, "effect_unverified", JSON.stringify(clicked));
    assert.equal(clicked.structuredContent.effect, "unknown");
    assert.equal(clicked.structuredContent.original_code, "helper_exited");
    assert.equal(helper.count("click"), before + 1, "exactly one delivery attempt");
    assert.equal(clicked.structuredContent.protectedForeground, "active", "re-established");
  });

  it("generation fencing: an answer from another generation never mutates the binding", async () => {
    const { observationId } = await acquire();
    const bound = authority.record.commits[0].helperLeaseId;
    // The Helper answers from generation 9 (not the bound one): fenced, re-acquired, retried.
    helper.state.override.set("click", (params) => {
      helper.state.override.delete("click");
      return {
        effect: "confirmed",
        operation: "click",
        route: "quartz_input",
        evidence: [],
        classification: "REQUIRES_FOREGROUND",
        mode: "EXCLUSIVE_FOREGROUND",
        input_delivery: "confirmed",
        application_effect: "confirmed",
        lease_id: params.lease_id,
        lease_state: "active",
        __generation: 9,
      };
    });
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.effect, "confirmed");
    const latest = authority.record.commits.at(-1).helperLeaseId;
    assert.notEqual(latest, bound, "the binding moved to a freshly acquired lease");
    assert.equal(lastCall("click").params.lease_id, latest);
  });

  it("native lease expiry re-acquires under the grant and retries once (checked before posting)", async () => {
    const { observationId } = await acquire();
    helper.state.expired.add(authority.record.commits[0].helperLeaseId);
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.effect, "confirmed", JSON.stringify(clicked));
    assert.equal(authority.record.commits.length, 2);
    assert.equal(authority.record.takeoverRequests, 1, "no second Allow");
    assert.equal(
      authority.record.releases.find((entry) => entry.leaseId === "authority-1")?.reason,
      "lease_expired",
    );
  });

  it("after a restart a changed window is NOT acted on: re-observe first", async () => {
    const { observationId } = await acquire();
    helper.restart();
    helper.state.bounds = { ...BOUNDS, x: 400 };
    helper.state.override.set("click", () => "absent");
    const before = helper.count("click");
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.code, "connection_generation_changed");
    assert.equal(clicked.structuredContent.recovered, true);
    assert.equal(clicked.structuredContent.delivery, "not_sent");
    assert.equal(helper.count("click"), before + 1, "only the refused attempt; no replay");
  });

  it("Stop invalidates the grant first: no re-acquire, native lease released, user owns the screen", async () => {
    const { observationId } = await acquire();
    const lease = authority.record.commits[0].helperLeaseId;
    authority.revoke();
    const commitsBefore = authority.record.commits.length;
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.code, "user_takeover");
    assert.equal(clicked.structuredContent.protectedForeground, "inactive");
    assert.equal(authority.record.commits.length, commitsBefore, "never re-acquires after Stop");
    assert.equal(lastCall("release_control")?.params.lease_id, lease, "native lease released");
    assert.equal(helper.count("click"), 0, "nothing was posted after Stop");
  });

  it("Stop with the Helper already dead still ends truthfully as user-owned", async () => {
    const { observationId } = await acquire();
    helper.restart();
    authority.revoke();
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.code, "user_takeover");
    assert.equal(authority.record.recoveries, 0, "a revoked grant never relaunches for protection");
    const status = await cua.execute({
      toolName: "computer.control_status",
      arguments: {},
      context: LOCAL,
    });
    assert.equal(JSON.parse(status.content[0].text).protectedForeground, "inactive");
  });

  it("an expired grant reports protected_grant_expired", async () => {
    const { observationId } = await acquire();
    authority.expire();
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.code, "protected_grant_expired");
    assert.equal(clicked.structuredContent.recoverable, false);
  });

  it("physical-input takeover ends the binding; the next action needs a new acquire", async () => {
    const { observationId } = await acquire();
    helper.state.override.set("click", () => ({
      effect: "refused",
      code: "interrupted",
      route: "none",
      evidence: [],
      classification: "REQUIRES_FOREGROUND",
      input_delivery: "none",
      application_effect: "unknown",
      mode: "EXCLUSIVE_FOREGROUND",
      lease_state: "interrupted",
    }));
    const clicked = await click(observationId);
    assert.equal(clicked.structuredContent.code, "user_takeover");
    assert.equal(clicked.structuredContent.original_code, "interrupted");
    assert.equal(authority.record.releases.at(-1).reason, "interrupted");
    helper.state.override.delete("click");
    const again = await click(observationId);
    assert.equal(again.structuredContent.code, "invalid_lease");
  });

  it("acquire_control again in the same task reuses the grant without asking or reserving", async () => {
    await acquire();
    const observationId = await observe();
    const again = await cua.execute({
      toolName: "computer.acquire_control",
      arguments: { observation_id: observationId },
      context: LOCAL,
    });
    assert.equal(again.structuredContent.effect, "confirmed");
    assert.equal(again.structuredContent.protectedForeground, "active");
    assert.equal(authority.record.begins.length, 1, "no second authority reservation");
    assert.equal(authority.record.takeoverRequests, 1);
  });

  it("key_press uses the injected lease too (Command+L shape is accepted)", async () => {
    const { observationId } = await acquire();
    const pressed = await cua.execute({
      toolName: "computer.key_press",
      arguments: {
        observation_id: observationId,
        key: "l",
        modifiers: ["command"],
      },
      context: LOCAL,
    });
    assert.equal(pressed.structuredContent.effect, "confirmed", JSON.stringify(pressed));
    assert.equal(lastCall("key_press").params.key, "l");
    assert.equal(lastCall("key_press").params.lease_id, authority.record.commits[0].helperLeaseId);
  });
});
