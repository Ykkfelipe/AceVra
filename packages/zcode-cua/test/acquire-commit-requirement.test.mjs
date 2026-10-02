// CUA-4 acquire-commit contract: a Helper-confirmed acquire whose envelope carries
// helper_identity.requirement must proceed to the lease-authority commit; a confirmed
// acquire WITHOUT the requirement must stay fail-closed (commit refused, lease released).
// Producer parity only — the consumer keeps requiring the verified requirement.
//
// Run: node --test packages/zcode-cua/test/acquire-commit-requirement.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { handleRequestLine, serializeResponse } from "../broker.js";
import { createComputerUseRuntime } from "../index.js";

const OBSERVATION_ID = "0f3c2a58-9b7e-4d61-a1c2-5e8f7a9b0c3d";
const LEASE_ID = "6139a6dd-8e10-4d15-825a-ab06949a7034";
const REQUIREMENT = 'identifier "dev.acevra.cua-helper" and anchor apple generic';
const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

describe("acquire commit consumes the verified helper requirement", () => {
  const servers = [];
  let dir;
  let socketPath;
  const seen = [];
  const releaseCalls = [];

  function startBackend(helperIdentity) {
    return {
      // 观察必须带 window_id 才拿得到前台几何，所以测试也走真实的 observe → acquire 顺序。
      observe: async () => ({
        operation: "observe",
        effect: "confirmed",
        route: "ax",
        classification: "READ",
        input_delivery: "none",
        application_effect: "none",
        evidence: [],
        pid: 4242,
        tree: { ok: true, observation_id: "A1B2C3D4-0000-4000-8000-000000000000", elements: [] },
        foreground_geometry: { observation_id: OBSERVATION_ID, window_bounds: { x: 0, y: 0 } },
        helper_identity: helperIdentity,
      }),
      acquire_control: async () => ({
        operation: "acquire_control",
        effect: "confirmed",
        route: "quartz_input",
        classification: "REQUIRES_FOREGROUND",
        mode: "EXCLUSIVE_FOREGROUND",
        input_delivery: "none",
        application_effect: "unknown",
        evidence: [],
        lease_id: LEASE_ID,
        helper_identity: helperIdentity,
      }),
      release_control: async (params) => {
        releaseCalls.push(params.lease_id);
        return {
          operation: "release_control",
          effect: "confirmed",
          route: "quartz_input",
          classification: "REQUIRES_FOREGROUND",
          input_delivery: "none",
          application_effect: "unknown",
          evidence: [],
          lease_id: params.lease_id,
          lease_state: "released",
          helper_identity: helperIdentity,
        };
      },
    };
  }

  async function startServer(backend) {
    seen.length = 0;
    releaseCalls.length = 0;
    if (!dir) dir = mkdtempSync(join(tmpdir(), "cua4-acquire-commit-test-"));
    socketPath = join(dir, `helper-${servers.length}.sock`);
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", async (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          seen.push(JSON.parse(line).method);
          socket.write(serializeResponse(await handleRequestLine(backend, line)));
          newline = buffer.indexOf("\n");
        }
      });
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(socketPath, resolve));
  }

  after(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
            server.unref();
          }),
      ),
    );
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function authority(recorder = {}) {
    return {
      // 屏幕接管已由用户批准（本测试关注租约本身，批准门见 takeover-grant.test.mjs）。
      async requestTakeover() {
        return { state: "granted" };
      },
      async takeoverStatus() {
        return { state: "granted" };
      },
      async beginAcquire() {
        return { leaseId: "authority-lease-1" };
      },
      async commitAcquire(leaseId, helperLeaseId, requirement) {
        recorder.commit = { leaseId, helperLeaseId, requirement };
        return { generation: 7 };
      },
      async release(leaseId, reason) {
        recorder.release = { leaseId, reason };
        return { status: "released" };
      },
      async stop() {
        recorder.stopped = true;
        return { status: "stopped" };
      },
      async admission() {
        return { paused: false };
      },
      async reportActivity() {
        return { accepted: true };
      },
    };
  }

  function runtime(leaseAuthority) {
    return createComputerUseRuntime({
      brokerSocketPath: socketPath,
      platform: "darwin",
      allowForegroundControl: () => true,
      leaseAuthority,
    });
  }

  /** 真实顺序：Helper 只为显式 window 签发前台几何，所以先观察再取租约。 */
  async function observeWindow(cua) {
    const observed = await cua.execute({
      toolName: "get_app_state",
      arguments: { pid: 4242, window_id: 501 },
      context: LOCAL,
    });
    assert.equal(observed.isError, undefined, JSON.stringify(observed.content?.[0]));
  }

  it("commits the authority lease when the confirmed acquire carries the requirement", async () => {
    await startServer(
      startBackend({
        verified: true,
        identifier: "dev.acevra.cua-helper",
        cd_hash: "abcd1234",
        ad_hoc: false,
        pid: 4242,
        bundle_validated: true,
        reason: "",
        requirement: REQUIREMENT,
      }),
    );
    const recorder = {};
    const cua = runtime(authority(recorder));
    await observeWindow(cua);
    const result = await cua.execute({
      toolName: "computer.acquire_control",
      arguments: { observation_id: OBSERVATION_ID },
      context: LOCAL,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content?.[0]));
    assert.equal(recorder.commit?.helperLeaseId, LEASE_ID);
    assert.equal(recorder.commit?.requirement, REQUIREMENT, "requirement reaches the authority");
    assert.equal(recorder.stopped, undefined, "acquisition must not be torn down");
    assert.deepEqual(releaseCalls, [], "confirmed acquire must not be force-released");
    assert.equal(result.structuredContent?.mode, "EXCLUSIVE_FOREGROUND");
    assert.ok(
      JSON.stringify(result.structuredContent).includes("lease_authority_generation"),
      "committed generation is surfaced",
    );
  });

  it("a declined screen takeover never reaches the authority or the Helper", async () => {
    await startServer(
      startBackend({
        verified: true,
        identifier: "dev.acevra.cua-helper",
        cd_hash: "abcd1234",
        ad_hoc: false,
        pid: 4242,
        bundle_validated: true,
        reason: "",
        requirement: REQUIREMENT,
      }),
    );
    const recorder = {};
    const declined = {
      ...authority(recorder),
      async requestTakeover(owner) {
        recorder.requested = owner;
        return { state: "denied" };
      },
      async beginAcquire() {
        recorder.begun = true;
        return { leaseId: "never" };
      },
    };
    const cua = runtime(declined);
    await observeWindow(cua);
    const result = await cua.execute({
      toolName: "computer.acquire_control",
      arguments: { observation_id: OBSERVATION_ID },
      context: LOCAL,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /takeover_declined/u);
    assert.deepEqual(recorder.requested, { session: "session-a", task: "turn-1" });
    assert.equal(recorder.begun, undefined, "no lease reservation without the user's Allow");
    assert.ok(!seen.includes("acquire_control"), "the Helper is never asked to acquire");
  });

  it("stays fail-closed when the confirmed acquire omits the requirement", async () => {
    await startServer(
      startBackend({
        verified: true,
        identifier: "dev.acevra.cua-helper",
        cd_hash: "abcd1234",
        ad_hoc: false,
        pid: 4242,
        bundle_validated: true,
        reason: "",
      }),
    );
    const recorder = {};
    const cua = runtime(authority(recorder));
    await observeWindow(cua);
    const result = await cua.execute({
      toolName: "computer.acquire_control",
      arguments: { observation_id: OBSERVATION_ID },
      context: LOCAL,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /verified Helper requirement is unavailable/u);
    assert.equal(recorder.commit, undefined, "missing requirement must not commit");
    assert.ok(releaseCalls.includes(LEASE_ID), "confirmed lease must be safely released");
  });

  it("an observation without a foreground window never asks the user", async () => {
    await startServer(startBackend({ verified: true, requirement: REQUIREMENT }));
    const recorder = {};
    const cua = runtime(authority(recorder));
    // 不带 window_id 的观察拿不到前台几何：弹卡只会花掉一次注定失败的同意。
    const result = await cua.execute({
      toolName: "computer.acquire_control",
      arguments: { observation_id: OBSERVATION_ID },
      context: LOCAL,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /foreground_geometry_unavailable/u);
    assert.equal(recorder.requested, undefined, "the user is never asked for an impossible lease");
    assert.deepEqual(seen, [], "the Helper is never asked either");
  });
});
