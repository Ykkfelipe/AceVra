/**
 * CUA-4 runtime session control: pause admission gate, best-effort activity reports with
 * positively identified targets, and the physical-input yield reason. Fake broker only; no TCC.
 *
 * Run: node --test packages/zcode-cua/test/runtime-session-control.test.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { handleRequestLine, serializeResponse } from "../broker.js";
import { createComputerUseRuntime } from "../index.js";

const VERIFIED_IDENTITY = Object.freeze({
  verified: true,
  identifier: "dev.acevra.cua-helper.development",
  team_id: "",
  cd_hash: "d2da364aa8e974b717f4acd1e16948867c0d7931",
  requirement: 'identifier "dev.acevra.cua-helper.development"',
  ad_hoc: false,
  pid: 4242,
  expected_identifier: "",
});
const LEASE_ID = "00000000-0000-0000-0000-000000000001";
const OBSERVATION_ID = "00000000-0000-0000-0000-000000000002";
const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

describe("CUA-4 runtime session control", () => {
  let dir;
  let socketPath;
  let server;
  const seen = [];
  const clickResult = { value: "unknown" };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cua4-runtime-test-"));
    socketPath = join(dir, "helper.sock");
    const backend = {
      permission_status: async () => ({
        available: true,
        platform: "darwin",
        identity_verified: true,
        helper_identity: VERIFIED_IDENTITY,
        accessibility: "granted",
        screen_recording: "granted",
      }),
      list_apps: async () => ({
        apps: [
          { pid: 101, bundle_id: "com.apple.Notes", name: "Notes" },
          { pid: 202, bundle_id: "com.example.Other", name: "Other" },
        ],
        count: 2,
        route: "workspace",
        effect: "confirmed",
        helper_identity: VERIFIED_IDENTITY,
      }),
      list_windows: async () => ({
        windows: [
          { window_id: 7, pid: 101, owner: "Notes", title: "Shopping list" },
          { window_id: 8, pid: 202, owner: "Other", title: "Not this one" },
        ],
        route: "workspace",
        effect: "confirmed",
        helper_identity: VERIFIED_IDENTITY,
      }),
      observe: async (params) => ({
        pid: params.pid,
        route: "ax",
        effect: "confirmed",
        helper_identity: VERIFIED_IDENTITY,
        image: {
          ok: true,
          path: `/Users/someone/.zcode/computer-use/observations/${OBSERVATION_ID}.png`,
          observation_id: OBSERVATION_ID,
          width: 100,
          height: 50,
          blank: false,
        },
        tree: {
          elements: [
            {
              index: 0,
              role: "AXButton",
              semantic_ref: "ref-1",
              frame: { x: 200, y: 100, w: 40, h: 20 },
            },
          ],
        },
      }),
      press: async (params) => ({
        operation: "press",
        semantic_ref: params.semantic_ref,
        classification: "BEST_EFFORT_BACKGROUND",
        route: "accessibility_action",
        effect: "unknown",
        evidence: [{ api_status: 0, verification: "unproven" }],
        helper_identity: VERIFIED_IDENTITY,
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
        helper_identity: VERIFIED_IDENTITY,
      }),
      click: async () =>
        clickResult.value === "interrupted"
          ? {
              operation: "click",
              effect: "refused",
              route: "none",
              classification: "REQUIRES_FOREGROUND",
              mode: "EXCLUSIVE_FOREGROUND",
              code: "interrupted",
              input_delivery: "none",
              application_effect: "unknown",
              evidence: [],
              helper_identity: VERIFIED_IDENTITY,
            }
          : {
              operation: "click",
              effect: "unknown",
              route: "quartz_input",
              classification: "REQUIRES_FOREGROUND",
              mode: "EXCLUSIVE_FOREGROUND",
              input_delivery: "confirmed",
              application_effect: "unknown",
              evidence: [],
              helper_identity: VERIFIED_IDENTITY,
            },
      release_control: async () => ({
        operation: "release_control",
        effect: "confirmed",
        route: "quartz_input",
        classification: "REQUIRES_FOREGROUND",
        input_delivery: "none",
        application_effect: "unknown",
        evidence: [],
        helper_identity: VERIFIED_IDENTITY,
      }),
    };
    server = createServer((socket) => {
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
    await new Promise((resolve) => server.listen(socketPath, resolve));
  });

  after(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function authority(overrides = {}) {
    const reports = [];
    const releases = [];
    return {
      reports,
      releases,
      async beginAcquire() {
        return { leaseId: "authority-lease-1" };
      },
      async commitAcquire() {
        return { generation: 1 };
      },
      async release(leaseId, reason) {
        releases.push({ leaseId, reason });
      },
      async stop() {
        return { status: "already_stopped" };
      },
      async admission() {
        return { paused: false };
      },
      async reportActivity(report) {
        reports.push(report);
        return { accepted: true };
      },
      ...overrides,
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

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("refuses every method except status reads while paused, before any broker dispatch", async () => {
    const paused = authority({ admission: async () => ({ paused: true, pausedAt: 1 }) });
    const cua = runtime(paused);
    const before = seen.length;
    for (const [toolName, args] of [
      ["get_app_state", { pid: 101 }],
      ["list_apps", {}],
      ["computer.press", { semantic_ref: "ref-1" }],
      ["computer.acquire_control", { observation_id: OBSERVATION_ID }],
    ]) {
      const result = await cua.execute({ toolName, arguments: args, context: LOCAL });
      assert.equal(result.isError, true, toolName);
      assert.equal(result.structuredContent.code, "paused", toolName);
      assert.equal(result.structuredContent.effect, "refused", toolName);
      assert.match(result.content[0].text, /paused by the user/u);
    }
    assert.equal(seen.length, before, "no paused call reaches the Helper");
    const status = await cua.execute({ toolName: "request_access", arguments: {}, context: LOCAL });
    assert.equal(status.isError, undefined, "status reads stay available while paused");
    assert.equal(
      paused.reports.filter((report) => report.method !== "permission_status").length,
      0,
    );
  });

  it("fails closed for mutation when admission cannot be read, but keeps reads working", async () => {
    const unreachable = authority({
      admission: async () => {
        throw new Error("timeout");
      },
    });
    const cua = runtime(unreachable);
    const pressed = await cua.execute({
      toolName: "computer.press",
      arguments: { semantic_ref: "ref-1" },
      context: LOCAL,
    });
    assert.equal(pressed.structuredContent.code, "lease_authority_unavailable");
    const listed = await cua.execute({ toolName: "list_apps", arguments: {}, context: LOCAL });
    assert.equal(listed.isError, undefined);
  });

  it("semantic actions report the target pid and a logical cursor at the observed element center", async () => {
    const recorder = authority();
    const cua = runtime(recorder);
    await cua.execute({ toolName: "list_apps", arguments: {}, context: LOCAL });
    await cua.execute({ toolName: "get_app_state", arguments: { pid: 101 }, context: LOCAL });
    await cua.execute({
      toolName: "computer.press",
      arguments: { semantic_ref: "ref-1" },
      context: LOCAL,
    });
    await settle();
    const press = recorder.reports.find((r) => r.method === "press" && r.phase === "completed");
    assert.deepEqual(press.workspaceCursor, { x: 220, y: 110 });
    assert.equal(press.target.pid, 101);
    assert.equal(press.target.app, "Notes");
    // 未知 ref（不是最近一次观察铸造的）不产生光标，也不猜目标。
    await cua.execute({
      toolName: "computer.press",
      arguments: { semantic_ref: "ref-unknown" },
      context: LOCAL,
    });
    await settle();
    const unknown = recorder.reports
      .filter((r) => r.method === "press" && r.phase === "completed")
      .at(-1);
    assert.equal(unknown.workspaceCursor, undefined);
    assert.equal(unknown.target, undefined);
  });

  it("reports activity with only positively identified target names and the frame reference", async () => {
    const recorder = authority();
    const cua = runtime(recorder);
    await cua.execute({ toolName: "list_apps", arguments: {}, context: LOCAL });
    await cua.execute({ toolName: "list_windows", arguments: {}, context: LOCAL });
    const observed = await cua.execute({
      toolName: "get_app_state",
      arguments: { pid: 101, window_id: 7 },
      context: LOCAL,
    });
    await settle();
    const completed = recorder.reports.filter(
      (report) => report.phase === "completed" && report.method === "observe",
    );
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].target, {
      pid: 101,
      windowId: 7,
      app: "Notes",
      bundleId: "com.apple.Notes",
      window: "Shopping list",
    });
    assert.equal(completed[0].observation.id, OBSERVATION_ID);
    assert.match(completed[0].observation.framePath, /observations\/.+\.png$/u);
    assert.equal(completed[0].session, "session-a");
    assert.equal(completed[0].task, "turn-1");
    // The model-facing result still never carries the host frame path.
    assert.doesNotMatch(observed.content[0].text, /\/Users\/someone/u);

    // A window id owned by another pid is never used to name this target.
    await cua.execute({
      toolName: "get_app_state",
      arguments: { pid: 101, window_id: 8 },
      context: LOCAL,
    });
    // An unlisted pid in a fresh session is reported by pid only.
    await cua.execute({
      toolName: "get_app_state",
      arguments: { pid: 999 },
      context: { ...LOCAL, sessionId: "session-b" },
    });
    await settle();
    const later = recorder.reports.filter(
      (report) => report.phase === "completed" && report.method === "observe",
    );
    assert.deepEqual(later[1].target, {
      pid: 101,
      windowId: 8,
      app: "Notes",
      bundleId: "com.apple.Notes",
    });
    assert.deepEqual(later[2].target, { pid: 999 });
    assert.equal(later[2].session, "session-b");
  });

  it("records a physical-input yield as interrupted and keeps unknown effects unknown", async () => {
    const recorder = authority();
    const cua = runtime(recorder);
    const acquired = await cua.execute({
      toolName: "computer.acquire_control",
      arguments: { observation_id: OBSERVATION_ID },
      context: LOCAL,
    });
    assert.equal(acquired.structuredContent.lease_id, LEASE_ID);
    clickResult.value = "unknown";
    const clicked = await cua.execute({
      toolName: "computer.click",
      arguments: { observation_id: OBSERVATION_ID, lease_id: LEASE_ID, point: { x: 1, y: 2 } },
      context: LOCAL,
    });
    await settle();
    const clickReport = recorder.reports.findLast(
      (report) => report.method === "click" && report.phase === "completed",
    );
    assert.equal(clicked.structuredContent.effect, "unknown");
    assert.equal(clickReport.effect, "unknown");
    assert.equal(clickReport.inputDelivery, "confirmed");
    assert.equal(clickReport.applicationEffect, "unknown");

    clickResult.value = "interrupted";
    const interrupted = await cua.execute({
      toolName: "computer.click",
      arguments: { observation_id: OBSERVATION_ID, lease_id: LEASE_ID, point: { x: 1, y: 2 } },
      context: LOCAL,
    });
    await settle();
    assert.equal(interrupted.structuredContent.code, "interrupted");
    assert.deepEqual(recorder.releases, [{ leaseId: "authority-lease-1", reason: "interrupted" }]);
    clickResult.value = "unknown";
  });

  it("never lets a failing activity report change the action result", async () => {
    const failing = authority({
      reportActivity: async () => {
        throw new Error("sideband down");
      },
    });
    const cua = runtime(failing);
    const pressed = await cua.execute({
      toolName: "computer.press",
      arguments: { semantic_ref: "ref-1" },
      context: LOCAL,
    });
    assert.equal(pressed.structuredContent.effect, "unknown");
    assert.equal(pressed.isError, undefined);
  });
});
