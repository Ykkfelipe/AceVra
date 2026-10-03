// Lease renewal: a protected lease must survive thinking gaps. The Helper's no-renewal window is
// 15 s (installed 78256d1f proved a fixed lifetime collapses any longer task into a reacquiring
// loop), so the runtime heartbeats `renew_lease` while a binding holds a native lease, and stops
// when the model releases.
//
// Run: node --test packages/zcode-cua/test/lease-renewal.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createProtectedForegroundController } from "../protected-runtime.js";

const IDENTITY = Object.freeze({
  verified: true,
  identifier: "dev.acevra.cua-helper",
  requirement: 'identifier "dev.acevra.cua-helper"',
});

// Helper broker 门禁的逐字镜像（native/cua-helper/BrokerServer.swift validForegroundBrokerParams）：
// 键集合必须精确等于 owner 字段 ∪ 方法自身字段，owner 字段是 ≤128 的非空字符串。
// 修复依据（2026-10-03 实测）：旧 fake 只记录 lease_id/owner_session 并一律确认，心跳把整个
// binding 对象当 owner_task 发出、每次被真实 Helper 以 bad_request 拒绝，测试却全绿。
const FOREGROUND_FIELDS = Object.freeze({
  acquire_control: ["observation_id"],
  renew_lease: ["lease_id"],
  release_control: ["lease_id"],
  activate_target: ["lease_id", "observation_id"],
  move_pointer: ["lease_id", "observation_id", "point"],
  click: ["lease_id", "observation_id", "point"],
  type_text: ["lease_id", "observation_id", "text"],
  key_press: ["lease_id", "observation_id", "key", "modifiers"],
  scroll: ["lease_id", "observation_id", "point", "delta_x", "delta_y"],
  drag: ["lease_id", "observation_id", "start", "end"],
});

function assertHelperForegroundContract(method, params) {
  const fields = FOREGROUND_FIELDS[method];
  if (!fields) return;
  const expected = new Set(["owner_session", "owner_task", ...fields]);
  const keys = Object.keys(params ?? {});
  const ownerValid = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
  if (
    keys.length !== expected.size ||
    !keys.every((key) => expected.has(key)) ||
    !ownerValid(params.owner_session) ||
    !ownerValid(params.owner_task)
  ) {
    throw Object.assign(new Error(`${method} request shape is invalid`), { code: "bad_request" });
  }
}

function makeDeps({ intervalMs }) {
  const calls = [];
  const bindings = new Map();
  const deps = {
    leaseRenewIntervalMs: intervalMs,
    leaseAuthority: {
      async admission() {
        return { paused: false };
      },
      async requestTakeover() {
        return { state: "granted" };
      },
      async takeoverStatus() {
        return { state: "granted" };
      },
      async grantView() {
        return { grantId: "grant-1", expiresAt: Date.now() + 15 * 60_000 };
      },
      async beginAcquire() {
        return { leaseId: "authority-1" };
      },
      async commitAcquire() {
        return { generation: 1 };
      },
      async release() {},
      async stop() {},
      async reportActivity() {
        return { accepted: true };
      },
    },
    foregroundObservations: new Map([
      ["session-a", new Map([["fg-obs-1", { window_bounds: { x: 1, y: 2 } }]])],
    ]),
  };
  deps.helperCall = async (method, params = {}) => {
    calls.push({
      method,
      lease_id: params.lease_id,
      owner_session: params.owner_session,
      owner_task: params.owner_task,
    });
    assertHelperForegroundContract(method, params);
    if (method === "observe") {
      return {
        pid: 4242,
        tree: { ok: true, observation_id: "tree-obs", elements: [] },
        foreground_geometry: { observation_id: "fg-obs-1" },
      };
    }
    if (method === "acquire_control") {
      return {
        effect: "confirmed",
        lease_id: "native-lease-1",
        lease_state: "active",
        helper_identity: IDENTITY,
      };
    }
    if (method === "renew_lease") {
      return { effect: "confirmed", lease_state: "active" };
    }
    if (method === "release_control") {
      return { effect: "confirmed", lease_state: "released" };
    }
    return { effect: "confirmed" };
  };
  return { deps, calls };
}

const CONTROLLER_INPUT = {
  toolName: "computer.acquire_control",
  arguments: { observation_id: "fg-obs-1" },
  context: {
    sessionId: "session-a",
    turnId: "task-1",
    runtimeScope: "main",
    clientMode: "desktop-continuous",
    deliveryKind: "desktop-continuous",
  },
};

describe("protected lease renewal heartbeat", () => {
  it("renews the native lease while the task holds it, and stops after release", async () => {
    const { deps, calls } = makeDeps({ intervalMs: 20 });
    const controller = createProtectedForegroundController(deps);
    // The controller's public surface is exercised through the runtime facade in other suites;
    // here we drive the two model methods directly through the controller's acquire/release.
    await controller.acquire({
      sessionId: "session-a",
      task: "task-1",
      observationId: "fg-obs-1",
    });
    const renewsBefore = calls.filter((c) => c.method === "renew_lease");
    await new Promise((r) => setTimeout(r, 80));
    const renewsAfter = calls.filter((c) => c.method === "renew_lease");
    assert.ok(renewsAfter.length > renewsBefore.length, "heartbeat must fire while held");
    assert.ok(
      renewsAfter.every(
        (c) =>
          c.lease_id === "native-lease-1" &&
          c.owner_session === "session-a" &&
          c.owner_task === "task-1",
      ),
      JSON.stringify(renewsAfter),
    );
    await controller.release({ sessionId: "session-a" });
    const countAtRelease = calls.filter((c) => c.method === "renew_lease").length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      calls.filter((c) => c.method === "renew_lease").length,
      countAtRelease,
      "heartbeat must stop after release",
    );
  });
});

// 回归（实测 2026-10-02）：Helper 侧终止（用户按 Esc / 到期）曾被心跳整个丢弃，
// authority/UI 一直显示接管中，安全辉光不消失。心跳必须把针对本租约的明确拒绝
// 在同一 tick 内传播给 lease authority；传输类失败仍不得触发释放。
describe("heartbeat propagates Helper-side termination", () => {
  function makeLiveDeps() {
    const { deps } = makeDeps({ intervalMs: 20 });
    const releases = [];
    const innerRelease = deps.leaseAuthority.release.bind(deps.leaseAuthority);
    deps.leaseAuthority.release = async (id, reason) => {
      releases.push({ id, reason });
      return innerRelease(id, reason);
    };
    const innerHelper = deps.helperCall;
    let renewAnswer = { effect: "confirmed", lease_state: "active" };
    deps.helperCall = async (method, params, timeoutMs) => {
      if (method === "renew_lease") {
        assertHelperForegroundContract(method, params);
        return renewAnswer;
      }
      return innerHelper(method, params, timeoutMs);
    };
    return { deps, releases, setRenewAnswer: (answer) => (renewAnswer = answer) };
  }

  it("user takeover: releases the authority lease with the typed code and drops the binding", async () => {
    const { deps, releases, setRenewAnswer } = makeLiveDeps();
    const controller = createProtectedForegroundController(deps);
    await controller.acquire({
      sessionId: "session-a",
      task: "task-1",
      observationId: "fg-obs-1",
    });
    setRenewAnswer({ effect: "refused", code: "user_takeover", lease_state: "inactive" });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(
      releases.some((r) => r.id === "authority-1" && r.reason === "user_takeover"),
      JSON.stringify(releases),
    );
    const status = await controller.status({ sessionId: "session-a", task: "task-1" });
    assert.equal(status.protectedForeground, "inactive");
  });

  it("lease expiry: releases the authority lease but keeps the binding reacquiring", async () => {
    const { deps, releases, setRenewAnswer } = makeLiveDeps();
    const controller = createProtectedForegroundController(deps);
    await controller.acquire({
      sessionId: "session-a",
      task: "task-1",
      observationId: "fg-obs-1",
    });
    setRenewAnswer({ effect: "refused", code: "lease_expired", lease_state: "inactive" });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(
      releases.some((r) => r.id === "authority-1" && r.reason === "lease_expired"),
      JSON.stringify(releases),
    );
    const status = await controller.status({ sessionId: "session-a", task: "task-1" });
    assert.equal(status.protectedForeground, "reacquiring");
  });

  it("transport failure on the heartbeat releases nothing", async () => {
    const { deps, releases } = makeLiveDeps();
    const innerHelper = deps.helperCall;
    deps.helperCall = async (method, params, timeoutMs) => {
      if (method === "renew_lease") {
        throw Object.assign(new Error("socket gone"), { code: "connection_closed" });
      }
      return innerHelper(method, params, timeoutMs);
    };
    const controller = createProtectedForegroundController(deps);
    await controller.acquire({
      sessionId: "session-a",
      task: "task-1",
      observationId: "fg-obs-1",
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(releases, []);
    const status = await controller.status({ sessionId: "session-a", task: "task-1" });
    assert.equal(status.protectedForeground, "reacquiring");
  });

  // 回归（2026-10-03 实测）：心跳的 bad_request 被整体吞掉，Helper 租约 15 s 静默死亡、
  // authority 30 s 才过期，UI 在模型仍持有任务时突然熄灭且无原因。契约类失败必须同一跳
  // 以 typed code 结束原生租约；绑定保留，下一次动作在仍有效的授权下重新获取。
  for (const code of ["bad_request", "not_authorized"]) {
    it(`contract failure (${code}) drops the native lease with the typed code`, async () => {
      const { deps, releases } = makeLiveDeps();
      const innerHelper = deps.helperCall;
      deps.helperCall = async (method, params, timeoutMs) => {
        if (method === "renew_lease") {
          throw Object.assign(new Error("rejected"), { code });
        }
        return innerHelper(method, params, timeoutMs);
      };
      const controller = createProtectedForegroundController(deps);
      await controller.acquire({
        sessionId: "session-a",
        task: "task-1",
        observationId: "fg-obs-1",
      });
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(
        releases.some((r) => r.id === "authority-1" && r.reason === code),
        JSON.stringify(releases),
      );
      const status = await controller.status({ sessionId: "session-a", task: "task-1" });
      assert.equal(status.protectedForeground, "reacquiring");
    });
  }

  it("a late answer for a replaced native lease never touches the new lease", async () => {
    const { deps, releases } = makeLiveDeps();
    const innerHelper = deps.helperCall;
    const pendingRenewals = new Map();
    let acquired = 0;
    deps.helperCall = async (method, params, timeoutMs) => {
      if (method === "renew_lease") {
        assertHelperForegroundContract(method, params);
        return await new Promise((resolve) => {
          if (!pendingRenewals.has(params.lease_id)) pendingRenewals.set(params.lease_id, resolve);
        });
      }
      if (method === "acquire_control") {
        acquired += 1;
        const result = await innerHelper(method, params, timeoutMs);
        return { ...result, lease_id: `native-lease-${acquired}` };
      }
      return innerHelper(method, params, timeoutMs);
    };
    const controller = createProtectedForegroundController(deps);
    await controller.acquire({ sessionId: "session-a", task: "task-1", observationId: "fg-obs-1" });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(pendingRenewals.has("native-lease-1"), "first lease renewal is in flight");
    // 旧租约的心跳尚未应答时，模型释放并在同一授权下重新获取了新原生租约。
    await controller.release({ sessionId: "session-a" });
    await controller.acquire({ sessionId: "session-a", task: "task-1", observationId: "fg-obs-1" });
    const releasesBefore = releases.length;
    pendingRenewals.get("native-lease-1")({
      effect: "refused",
      code: "user_takeover",
      lease_state: "inactive",
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(releases.length, releasesBefore, JSON.stringify(releases));
    assert.equal(controller.describe("session-a").protectedForeground, "active");
    await controller.release({ sessionId: "session-a" });
  });

  it("a heartbeat timeout releases nothing", async () => {
    const { deps, releases } = makeLiveDeps();
    const innerHelper = deps.helperCall;
    deps.helperCall = async (method, params, timeoutMs) => {
      if (method === "renew_lease") {
        throw Object.assign(new Error("broker request timed out"), { code: "timeout" });
      }
      return innerHelper(method, params, timeoutMs);
    };
    const controller = createProtectedForegroundController(deps);
    await controller.acquire({
      sessionId: "session-a",
      task: "task-1",
      observationId: "fg-obs-1",
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(releases, []);
  });

  it("a rejected keepalive report never escapes as an unhandled rejection", async () => {
    const { deps } = makeDeps({ intervalMs: 20 });
    deps.leaseAuthority.reportActivity = async () => {
      throw Object.assign(new Error("sideband down"), { code: "timeout" });
    };
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = createProtectedForegroundController(deps);
      await controller.acquire({
        sessionId: "session-a",
        task: "task-1",
        observationId: "fg-obs-1",
      });
      await new Promise((r) => setTimeout(r, 80));
      await controller.release({ sessionId: "session-a" });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  it("feeds the authority keepalive on every confirmed renewal", async () => {
    // 回归（实测 2026-10-02）：内核回收后无人 release，authority 记录与辉光常驻。心跳确认
    // 必须经活动 sideband（method "renew_lease"，callId = authority lease id）为记录续期；
    // authority 侧 30s 窗口惰性过期（services 测试覆盖）。
    const { deps } = makeDeps({ intervalMs: 20 });
    const reports = [];
    const innerReport = deps.leaseAuthority.reportActivity?.bind(deps.leaseAuthority);
    deps.leaseAuthority.reportActivity = async (report) => {
      reports.push(report);
      return innerReport?.(report);
    };
    const controller = createProtectedForegroundController(deps);
    await controller.acquire({
      sessionId: "session-a",
      task: "task-1",
      observationId: "fg-obs-1",
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(
      reports.some(
        (r) =>
          r.method === "renew_lease" && r.callId === "authority-1" && r.session === "session-a",
      ),
      `heartbeat must keepalive the authority record: ${JSON.stringify(reports)}`,
    );
    await controller.release({ sessionId: "session-a" });
    const countAtRelease = reports.length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(reports.length, countAtRelease, "no keepalive after release");
  });
});
