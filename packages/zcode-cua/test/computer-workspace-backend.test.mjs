// M2A AgentWorkspaceBackend contract tests: truthful capabilities, router preference,
// the no-lease guarantee, the zero-steal contract, honest fallback, and frame/backend
// tagging. No live macOS automation here — the live zero-steal proof runs in the
// milestone acceptance against the controlled fixture.
//
// Run: node --test packages/zcode-cua/test/computer-workspace-backend.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createComputerBackendRouter,
  createNativeMacBackend,
} from "../computer-backend.js";
import { createAgentWorkspaceBackend } from "../computer-workspace-backend.js";

const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

function recordingExecute(response) {
  const calls = [];
  const execute = async (input) => {
    calls.push(input);
    if (response === undefined) return { ok: true, toolName: input.toolName };
    return typeof response === "function" ? response(input) : response;
  };
  return { calls, execute };
}

const CONFIRMED_CLICK = {
  operation: "workspace_click",
  effect: "confirmed",
  route: "accessibility_action",
  classification: "BACKGROUND_SAFE",
  mode: "AGENT_WORKSPACE",
  input_delivery: "confirmed",
  application_effect: "unknown",
  target: { pid: 4242, role: "AXButton", strategy: "role_label" },
  element_center: { x: 120, y: 90 },
  zero_steal: {
    kind: "zero_steal",
    frontmost_before: 999,
    frontmost_after: 999,
    frontmost_unchanged: true,
    cursor_before: { x: 10, y: 10 },
    cursor_after: { x: 10, y: 10 },
    cursor_unchanged: true,
  },
};

describe("AgentWorkspaceBackend capability report", () => {
  it("reports exactly the capabilities this substrate actually has", () => {
    const { execute } = recordingExecute();
    const backend = createAgentWorkspaceBackend({ execute });
    assert.deepEqual(backend.capabilities, {
      id: "agent-workspace",
      observes: true,
      backgroundSemanticMutation: true,
      independentPointer: true,
      independentTextInput: true,
      // Honest for M2A: no virtual display exists yet. The M2 substrate may upgrade this.
      ownsForegroundWorkspace: false,
      requiresUserForegroundForPhysicalInput: false,
      frameStream: true,
    });
  });

  it("refuses to construct without the runtime execute seam", () => {
    assert.throws(() => createAgentWorkspaceBackend({}), /execute seam/u);
  });
});

describe("router integration", () => {
  it("prefers the workspace backend for pointer/keyboard work when available", () => {
    const { execute } = recordingExecute();
    const router = createComputerBackendRouter({
      backends: [createNativeMacBackend({ execute }), createAgentWorkspaceBackend({ execute })],
    });
    for (const method of ["workspace_click", "workspace_type_text", "click", "type_text"]) {
      const decision = router.routeFor(method);
      assert.equal(decision.backend.capabilities.id, "agent-workspace", method);
      assert.equal(decision.routeClass, "workspace", method);
    }
  });

  it("routes background-class work to the workspace backend without touching native", async () => {
    const native = recordingExecute();
    const workspace = recordingExecute();
    const router = createComputerBackendRouter({
      backends: [
        createNativeMacBackend({ execute: native.execute }),
        createAgentWorkspaceBackend({ execute: workspace.execute }),
      ],
    });
    const routed = await router.perform("set_value", { semantic_ref: "r", value: "v" }, LOCAL);
    assert.equal(routed.backendId, "agent-workspace");
    assert.equal(routed.routeClass, "background");
    assert.equal(native.calls.length, 0, "native runtime untouched");
    assert.deepEqual(workspace.calls[0]?.toolName, "computer.set_value");
  });

  it("falls back to the native foreground route when the workspace is unavailable", () => {
    const { execute } = recordingExecute();
    const router = createComputerBackendRouter({
      backends: [createNativeMacBackend({ execute })],
    });
    const decision = router.routeFor("click");
    assert.equal(decision.backend.capabilities.id, "native-mac");
    assert.equal(decision.routeClass, "foreground");
  });

  it("propagates backend errors instead of silently retrying another route", async () => {
    const failing = {
      capabilities: createAgentWorkspaceBackend({ execute: async () => ({}) }).capabilities,
      perform: async () => {
        throw new Error("workspace substrate is not available");
      },
    };
    const { calls, execute } = recordingExecute();
    const router = createComputerBackendRouter({
      backends: [failing, createNativeMacBackend({ execute })],
    });
    await assert.rejects(
      () => router.perform("workspace_click", { pid: 1, target_role: "AXButton", target_label: "Go" }, LOCAL),
      /not available/u,
    );
    assert.equal(calls.length, 0, "a failed workspace action must not silently re-run natively");
  });
});

describe("no native exclusive lease for workspace actions", () => {
  it("never dispatches lease/takeover tools from the workspace backend", async () => {
    const { calls, execute } = recordingExecute();
    const backend = createAgentWorkspaceBackend({ execute });
    await backend.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Go" }, LOCAL);
    await backend.perform("workspace_type_text", { pid: 4242, text: "hi" }, LOCAL);
    await backend.perform("observe", { pid: 4242 }, LOCAL);
    for (const call of calls) {
      assert.ok(
        !["computer.acquire_control", "computer.activate_target", "computer.release_control", "computer.move_pointer", "computer.click", "computer.type_text"].includes(call.toolName),
        `workspace action produced takeover tool call: ${call.toolName}`,
      );
    }
  });

  it("dispatches the workspace tool names through the same sanctioned seam", async () => {
    const { calls, execute } = recordingExecute();
    const backend = createAgentWorkspaceBackend({ execute });
    await backend.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Go" }, LOCAL);
    assert.deepEqual(calls, [
      {
        toolName: "computer.workspace_click",
        arguments: { pid: 4242, target_role: "AXButton", target_label: "Go" },
        context: LOCAL,
      },
    ]);
  });
});

describe("zero-steal contract", () => {
  it("passes the Helper's zero-steal envelope through untouched (no fabrication)", async () => {
    const { execute } = recordingExecute(CONFIRMED_CLICK);
    const backend = createAgentWorkspaceBackend({ execute });
    const { result } = await backend.perform(
      "workspace_click",
      { pid: 4242, target_role: "AXButton", target_label: "Go" },
      LOCAL,
    );
    assert.deepEqual(result.zero_steal, CONFIRMED_CLICK.zero_steal);
    assert.equal(result.zero_steal.frontmost_unchanged, true);
    assert.equal(result.zero_steal.cursor_unchanged, true);
  });

  it("pairs host snapshots into the route-level zero-steal record when a probe is wired", async () => {
    let reads = 0;
    const backend = createAgentWorkspaceBackend({
      execute: async () => ({ ok: true }),
      snapshot: async () => {
        reads += 1;
        // Frontmost app id 55 and cursor (12, 34) on both sides: nothing moved.
        return { frontmost: 55, cursor: { x: 12, y: 34 } };
      },
    });
    const { zeroSteal } = await backend.perform("workspace_click", { pid: 1, point: { x: 3, y: 4 } }, LOCAL);
    assert.equal(reads, 2, "snapshot taken before and after the action");
    assert.equal(zeroSteal.frontmostUnchanged, true);
    assert.equal(zeroSteal.cursorUnchanged, true);
  });

  it("marks the zero-steal record broken when the user's foreground changes", async () => {
    let reads = 0;
    const backend = createAgentWorkspaceBackend({
      execute: async () => ({ ok: true }),
      snapshot: async () => {
        reads += 1;
        return reads === 1
          ? { frontmost: 55, cursor: { x: 12, y: 34 } }
          : { frontmost: 77, cursor: { x: 12, y: 34 } };
      },
    });
    const { zeroSteal } = await backend.perform("workspace_click", { pid: 1, point: { x: 3, y: 4 } }, LOCAL);
    assert.equal(zeroSteal.frontmostUnchanged, false, "a foreground change must be reported, never hidden");
  });
});

describe("agent cursor (logical, backend-owned)", () => {
  it("tracks the last workspace action without touching any OS cursor", async () => {
    const { execute } = recordingExecute(CONFIRMED_CLICK);
    const backend = createAgentWorkspaceBackend({ execute });
    assert.deepEqual(backend.agentPointer, { x: null, y: null, target: null, updatedAt: null });
    await backend.perform("workspace_click", { pid: 4242, target_role: "AXButton", target_label: "Go" }, LOCAL);
    const pointer = backend.agentPointer;
    assert.equal(pointer.x, 120, "logical cursor lands on the element the Helper resolved");
    assert.equal(pointer.y, 90);
    assert.equal(pointer.target.pid, 4242);
    assert.ok(Number.isFinite(pointer.updatedAt));
  });

  it("prefers an explicit point target for the logical cursor", async () => {
    const { execute } = recordingExecute();
    const backend = createAgentWorkspaceBackend({ execute });
    await backend.perform("workspace_click", { pid: 1, point: { x: 50, y: 60 } }, LOCAL);
    assert.equal(backend.agentPointer.x, 50);
    assert.equal(backend.agentPointer.y, 60);
  });
});

describe("frame/backend tagging", () => {
  it("tags routed frames and results with the workspace backend id", async () => {
    const { execute } = recordingExecute();
    const router = createComputerBackendRouter({
      backends: [createNativeMacBackend({ execute }), createAgentWorkspaceBackend({ execute })],
    });
    const routed = await router.perform("observe", { pid: 4242 }, LOCAL);
    assert.equal(routed.backendId, "agent-workspace", "workspace frames must not be confused with native ones");
    assert.equal(routed.routeClass, "background");
  });
});

describe("native backend unchanged", () => {
  it("still reports foreground routes for physical work when the workspace is absent", () => {
    const { execute } = recordingExecute();
    const backend = createNativeMacBackend({ execute });
    assert.equal(backend.capabilities.requiresUserForegroundForPhysicalInput, true);
    const router = createComputerBackendRouter({ backends: [backend] });
    assert.equal(router.routeFor("type_text").routeClass, "foreground");
  });
});
