// M1 ComputerBackend contract tests: dispatch preservation, truthful capabilities,
// routing priority, and the permanent user-foreground invariant (a route labeled
// `background` must never activate another app, move the user's cursor, or take the
// native exclusive lease).
//
// Run: node --test packages/zcode-cua/test/computer-backend.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPUTER_BACKEND_METHODS,
  COMPUTER_METHOD_CLASSES,
  createComputerBackendRouter,
  createNativeMacBackend,
  normalizeBackendCapabilities,
  routeClassFor,
} from "../computer-backend.js";
import { COMPUTER_USE_MODEL_TO_METHOD } from "../capability-contract.js";

const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

function recordingExecute() {
  const calls = [];
  const execute = async (input) => {
    calls.push(input);
    return { ok: true, method: input.toolName };
  };
  return { calls, execute };
}

function fakeWorkspaceBackend(overrides = {}) {
  const calls = [];
  return {
    calls,
    backend: {
      capabilities: normalizeBackendCapabilities({
        id: "agent-workspace",
        observes: true,
        backgroundSemanticMutation: true,
        independentPointer: true,
        independentTextInput: true,
        ownsForegroundWorkspace: true,
        requiresUserForegroundForPhysicalInput: false,
        frameStream: true,
        ...overrides,
      }),
      async perform(method, args, context) {
        calls.push({ method, args, context });
        return { route: "workspace", result: { workspace: true, method } };
      },
    },
  };
}

describe("NativeMacBackend preserves the current native route", () => {
  it("dispatches through the sanctioned runtime seam with the model-facing tool name", async () => {
    const { calls, execute } = recordingExecute();
    const backend = createNativeMacBackend({ execute });
    const { route, result } = await backend.perform("observe", { pid: 101 }, LOCAL);
    assert.equal(route, "background");
    assert.deepEqual(calls, [
      { toolName: "get_app_state", arguments: { pid: 101 }, context: LOCAL },
    ]);
    assert.deepEqual(result, { ok: true, method: "get_app_state" });
  });

  it("maps every broker method to the same model-facing tool name the surface uses today", async () => {
    const { calls, execute } = recordingExecute();
    const backend = createNativeMacBackend({ execute });
    const namesFor = new Map();
    for (const [name, method] of Object.entries(COMPUTER_USE_MODEL_TO_METHOD)) {
      namesFor.set(method, [...(namesFor.get(method) ?? []), name]);
    }
    for (const method of COMPUTER_BACKEND_METHODS) {
      calls.length = 0;
      await backend.perform(method, {}, LOCAL);
      assert.equal(calls.length, 1, method);
      assert.ok(
        namesFor.get(method).includes(calls[0].toolName),
        `${method}: dispatched as ${calls[0].toolName}, expected one of ${namesFor.get(method).join("|")}`,
      );
      assert.deepEqual(calls[0].arguments, {}, method);
      assert.deepEqual(calls[0].context, LOCAL, method);
    }
  });

  it("reports only capabilities the native implementation actually has", () => {
    const backend = createNativeMacBackend({ execute: async () => ({}) });
    assert.deepEqual(backend.capabilities, {
      id: "native-mac",
      observes: true,
      backgroundSemanticMutation: true,
      independentPointer: false,
      independentTextInput: false,
      ownsForegroundWorkspace: false,
      requiresUserForegroundForPhysicalInput: true,
      frameStream: false,
    });
  });

  it("refuses to construct without the runtime execute seam", () => {
    assert.throws(() => createNativeMacBackend({}), /execute seam/u);
  });
});

describe("routing priority", () => {
  it("routes everything to native when it is the only backend (M1 shape)", async () => {
    const { execute } = recordingExecute();
    const router = createComputerBackendRouter({
      backends: [createNativeMacBackend({ execute })],
    });
    assert.equal(router.routeFor("observe").routeClass, "background");
    assert.equal(router.routeFor("observe").backend.capabilities.id, "native-mac");
    assert.equal(router.routeFor("set_value").routeClass, "background");
    assert.equal(router.routeFor("click").routeClass, "foreground");
    assert.equal(router.routeFor("type_text").routeClass, "foreground");
    assert.equal(router.routeFor("acquire_control").routeClass, "foreground");
    const routed = await router.perform("set_value", { semantic_ref: "r", value: "v" }, LOCAL);
    assert.equal(routed.routeClass, "background");
    assert.equal(routed.backendId, "native-mac");
  });

  it("prefers an independent-workspace backend for physical input when one exists", () => {
    const { execute } = recordingExecute();
    const workspace = fakeWorkspaceBackend();
    const router = createComputerBackendRouter({
      backends: [createNativeMacBackend({ execute }), workspace.backend],
    });
    for (const method of ["click", "type_text", "key_press", "scroll", "drag", "move_pointer"]) {
      const decision = router.routeFor(method);
      assert.equal(decision.backend.capabilities.id, "agent-workspace", method);
      assert.equal(decision.routeClass, "workspace", method);
    }
  });

  it("keeps lease lifecycle on the native backend even with a workspace present", () => {
    const { execute } = recordingExecute();
    const workspace = fakeWorkspaceBackend();
    const router = createComputerBackendRouter({
      backends: [createNativeMacBackend({ execute }), workspace.backend],
    });
    for (const method of ["acquire_control", "release_control", "activate_target"]) {
      const decision = router.routeFor(method);
      assert.equal(decision.backend.capabilities.id, "native-mac", method);
      assert.equal(decision.routeClass, "foreground", method);
    }
  });

  it("prefers the non-user-foreground backend for background operations when both qualify", async () => {
    const { calls, execute } = recordingExecute();
    const workspace = fakeWorkspaceBackend();
    const router = createComputerBackendRouter({
      backends: [createNativeMacBackend({ execute }), workspace.backend],
    });
    const routed = await router.perform("set_value", { semantic_ref: "r", value: "v" }, LOCAL);
    assert.equal(routed.backendId, "agent-workspace");
    assert.equal(routed.routeClass, "background");
    assert.equal(calls.length, 0, "native runtime must not be touched for the background op");
    assert.deepEqual(workspace.calls[0].method, "set_value");
  });

  it("falls back to the native foreground route when no independent backend exists", () => {
    const { execute } = recordingExecute();
    const router = createComputerBackendRouter({
      backends: [createNativeMacBackend({ execute })],
    });
    const decision = router.routeFor("click");
    assert.equal(decision.backend.capabilities.id, "native-mac");
    assert.equal(decision.routeClass, "foreground");
  });

  it("refuses to construct with no backends", () => {
    assert.throws(() => createComputerBackendRouter({ backends: [] }), /at least one backend/u);
  });
});

describe("user-foreground invariant (permanent)", () => {
  const backendSets = () => {
    const { execute } = recordingExecute();
    return [
      [createNativeMacBackend({ execute })],
      [createNativeMacBackend({ execute }), fakeWorkspaceBackend().backend],
      [fakeWorkspaceBackend().backend, createNativeMacBackend({ execute })],
      [fakeWorkspaceBackend().backend],
    ];
  };

  it("never labels a route `background` unless the method class and backend allow it", () => {
    for (const backends of backendSets()) {
      const router = createComputerBackendRouter({ backends });
      for (const method of COMPUTER_BACKEND_METHODS) {
        let decision;
        try {
          decision = router.routeFor(method);
        } catch (error) {
          // A backend set that cannot serve a method (e.g. lease lifecycle without the
          // native backend) refuses routing instead of mislabeling it — that is the
          // truthful behavior this invariant protects.
          assert.match(String(error), /no Computer backend supports method/u);
          continue;
        }
        const { backend, routeClass } = decision;
        if (routeClass === "background") {
          // The background label is a promise about the METHOD CLASS: reads and semantic
          // mutation never activate an app, move the user's cursor, or take the lease.
          assert.equal(
            COMPUTER_METHOD_CLASSES[method],
            "background",
            `${method}: background route requires a background-class method`,
          );
          assert.equal(routeClassFor(method, backend.capabilities), "background");
        }
        if (routeClass === "foreground") {
          assert.equal(backend.capabilities.requiresUserForegroundForPhysicalInput, true);
        }
        if (routeClass === "workspace") {
          // "workspace" = the backend performs the physical work independently of the
          // user's foreground (owned surface or pid-targeted synthesis).
          assert.notEqual(
            backend.capabilities.requiresUserForegroundForPhysicalInput,
            true,
            `${method}: workspace routes require foreground-independent delivery`,
          );
        }
      }
    }
  });

  it("never synthesizes takeover calls for a background-routed operation", async () => {
    const { calls, execute } = recordingExecute();
    const native = createNativeMacBackend({ execute });
    const workspace = fakeWorkspaceBackend();
    const router = createComputerBackendRouter({
      backends: [native, workspace.backend],
    });
    for (const method of ["observe", "list_apps", "list_windows", "press", "set_value"]) {
      calls.length = 0;
      await router.perform(method, {}, LOCAL);
      for (const call of calls) {
        assert.ok(
          ![
            "computer.acquire_control",
            "computer.activate_target",
            "computer.move_pointer",
          ].includes(call.toolName),
          `background ${method} must not produce takeover call ${call.toolName}`,
        );
      }
    }
  });

  it("reads stay background even on the user-foreground backend (they disturb nothing)", () => {
    const nativeCaps = createNativeMacBackend({ execute: async () => ({}) }).capabilities;
    assert.equal(routeClassFor("observe", nativeCaps), "background");
    assert.equal(routeClassFor("press", nativeCaps), "background");
  });

  it("physical input on a user-foreground backend is always a foreground route", () => {
    const nativeCaps = createNativeMacBackend({ execute: async () => ({}) }).capabilities;
    assert.equal(routeClassFor("click", nativeCaps), "foreground");
    assert.equal(routeClassFor("type_text", nativeCaps), "foreground");
  });
});

describe("capability model", () => {
  it("rejects fabricated or incomplete capability reports", () => {
    assert.throws(() => normalizeBackendCapabilities({ id: "x" }), /missing/u);
    assert.throws(
      () =>
        normalizeBackendCapabilities({
          id: "",
          observes: true,
          backgroundSemanticMutation: false,
          independentPointer: false,
          independentTextInput: false,
          ownsForegroundWorkspace: false,
          requiresUserForegroundForPhysicalInput: false,
          frameStream: false,
        }),
      /id/u,
    );
  });

  it("keeps the method classes closed and total over the backend method set", () => {
    for (const method of COMPUTER_BACKEND_METHODS) {
      assert.ok(COMPUTER_METHOD_CLASSES[method], `unclassified backend method: ${method}`);
    }
  });
});
