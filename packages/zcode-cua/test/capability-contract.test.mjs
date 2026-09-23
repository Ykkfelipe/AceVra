import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPUTER_USE_BACKEND_SUPPORT,
  canonicalComputerUseMcpName,
  COMPUTER_USE_ACTION_CLASSIFICATIONS,
  COMPUTER_USE_CLASSIFICATIONS,
  COMPUTER_USE_EFFECTS,
  COMPUTER_USE_METHODS,
  COMPUTER_USE_MODEL_GUIDANCE,
  COMPUTER_USE_MODEL_TO_METHOD,
  normalizeComputerUseResult,
  resolveComputerUseMethod,
  resolveComputerUseCapabilities,
  validSemanticActionInput,
} from "../capability-contract.js";

describe("canonical Computer Use contract", () => {
  it("maps each public model name to the same backend-independent method", () => {
    assert.deepEqual(COMPUTER_USE_MODEL_TO_METHOD, {
      list_apps: "list_apps",
      list_windows: "list_windows",
      get_app_state: "observe",
      screenshot: "observe",
      request_access: "permission_status",
      "computer.press": "press",
      "computer.set_value": "set_value",
    });
    for (const [publicName, method] of Object.entries(COMPUTER_USE_MODEL_TO_METHOD)) {
      assert.equal(resolveComputerUseMethod(publicName), method);
    }
    assert.equal(resolveComputerUseMethod("zai_press"), undefined);
    assert.equal(resolveComputerUseMethod("codex_press"), undefined);
    for (const backend of ["z.ai", "azure_openai", "command_code_openai_compatible"]) {
      assert.equal(
        canonicalComputerUseMcpName("computer_press"),
        "mcp__computer-use__computer_press",
        backend,
      );
      assert.equal(
        canonicalComputerUseMcpName("computer_set_value"),
        "mcp__computer-use__computer_set_value",
        backend,
      );
    }
  });

  it("keeps action classification and supported execution adapter boundaries centralized", () => {
    assert.equal(COMPUTER_USE_METHODS.press, "mutation");
    assert.equal(COMPUTER_USE_METHODS.set_value, "mutation");
    assert.deepEqual(COMPUTER_USE_ACTION_CLASSIFICATIONS, {
      press: "BEST_EFFORT_BACKGROUND",
      set_value: "BEST_EFFORT_BACKGROUND",
    });
    assert.deepEqual(COMPUTER_USE_CLASSIFICATIONS, [
      "BACKGROUND_SAFE",
      "BEST_EFFORT_BACKGROUND",
      "REQUIRES_FOREGROUND",
      "UNSUPPORTED",
    ]);
    assert.equal(COMPUTER_USE_BACKEND_SUPPORT["z.ai"], true);
    assert.equal(COMPUTER_USE_BACKEND_SUPPORT.azure_openai, true);
    assert.equal(COMPUTER_USE_BACKEND_SUPPORT.command_code_openai_compatible, true);
    assert.equal(COMPUTER_USE_BACKEND_SUPPORT.codex_execution_backend, false);
    assert.equal(COMPUTER_USE_BACKEND_SUPPORT.claude_code_execution_backend, false);
  });

  it("allows only observation-derived semantic references for mutation", () => {
    assert.equal(validSemanticActionInput("press", { semantic_ref: "opaque-ref" }), true);
    assert.equal(validSemanticActionInput("press", { semantic_ref: "opaque-ref", pid: 10 }), false);
    assert.equal(validSemanticActionInput("press", { pid: 10, path: [0] }), false);
    assert.equal(
      validSemanticActionInput("press", { semantic_ref: "opaque-ref", x: 10, y: 20 }),
      false,
    );
    assert.equal(
      validSemanticActionInput("set_value", { semantic_ref: "opaque-ref", value: "ready" }),
      true,
    );
    assert.equal(
      validSemanticActionInput("set_value", {
        semantic_ref: "opaque-ref",
        value: "x".repeat(4097),
      }),
      false,
    );
  });

  it("preserves helper effects and provenance without trusting malformed values", () => {
    for (const effect of COMPUTER_USE_EFFECTS) {
      const result = {
        operation: "press",
        route: "accessibility_action",
        classification: "BEST_EFFORT_BACKGROUND",
        effect,
        evidence: [{ kind: "semantic_action" }],
        ...(effect === "refused" ? { code: "stale_target" } : {}),
      };
      assert.deepEqual(normalizeComputerUseResult(result), result);
      if (effect === "refused")
        assert.equal(normalizeComputerUseResult(result).code, "stale_target");
    }
    assert.equal(normalizeComputerUseResult({ effect: "success" }).effect, "failed");
    assert.equal(
      normalizeComputerUseResult({
        operation: "press",
        effect: "confirmed",
        route: "accessibility_action",
        classification: "BACKGROUND_SAFE",
        evidence: [],
      }).effect,
      "failed",
    );
    assert.equal(
      normalizeComputerUseResult({ effect: "confirmed", route: "/private/home", evidence: [] })
        .effect,
      "failed",
    );
  });

  it("provides one shared loop instruction with actionable stale and unknown handling", () => {
    assert.match(COMPUTER_USE_MODEL_GUIDANCE, /permission_status capabilities first/);
    assert.match(COMPUTER_USE_MODEL_GUIDANCE, /observe before/);
    assert.match(COMPUTER_USE_MODEL_GUIDANCE, /unknown as success/);
    assert.match(COMPUTER_USE_MODEL_GUIDANCE, /stale_target/);
    assert.match(COMPUTER_USE_MODEL_GUIDANCE, /Coordinate input is not available/);
  });

  it("advertises only verified platform and permission capabilities", () => {
    const unavailable = resolveComputerUseCapabilities({
      platform: "linux",
      helperVerified: false,
      accessibility: "granted",
    });
    assert.equal(
      Object.values(unavailable).every((value) => value === false),
      true,
    );
    const denied = resolveComputerUseCapabilities({
      platform: "darwin",
      helperVerified: true,
      accessibility: "denied",
    });
    assert.equal(denied.press, false);
    assert.equal(denied.set_value, false);
    assert.equal(denied.observe, false);
    assert.equal(denied.list_apps, true);
    assert.equal(denied.screenshot, "probe_required");
    const granted = resolveComputerUseCapabilities({
      platform: "darwin",
      helperVerified: true,
      accessibility: "granted",
    });
    assert.equal(granted.press, true);
    assert.equal(granted.set_value, true);
  });
});
