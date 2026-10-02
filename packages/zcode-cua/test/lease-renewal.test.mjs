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
    calls.push({ method, lease_id: params.lease_id, owner_session: params.owner_session });
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
      renewsAfter.every((c) => c.lease_id === "native-lease-1" && c.owner_session === "session-a"),
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
