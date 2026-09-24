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
  validForegroundInput,
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
      "computer.control_status": "control_status",
      "computer.acquire_control": "acquire_control",
      "computer.release_control": "release_control",
      "computer.activate_target": "activate_target",
      "computer.move_pointer": "move_pointer",
      "computer.click": "click",
      "computer.type_text": "type_text",
      "computer.key_press": "key_press",
      "computer.scroll": "scroll",
      "computer.drag": "drag",
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
    assert.equal(COMPUTER_USE_ACTION_CLASSIFICATIONS.press, "BEST_EFFORT_BACKGROUND");
    assert.equal(COMPUTER_USE_ACTION_CLASSIFICATIONS.set_value, "BEST_EFFORT_BACKGROUND");
    for (const method of [
      "acquire_control",
      "release_control",
      "activate_target",
      "move_pointer",
      "click",
      "type_text",
      "key_press",
      "scroll",
      "drag",
    ]) {
      assert.equal(COMPUTER_USE_ACTION_CLASSIFICATIONS[method], "REQUIRES_FOREGROUND");
    }
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
    assert.match(COMPUTER_USE_MODEL_GUIDANCE, /exclusive acquisition/);
    assert.match(COMPUTER_USE_MODEL_GUIDANCE, /interruption stop/);
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
    assert.equal(granted.click, "probe_required");
  });

  it("rejects unbounded or unscoped foreground input before the broker", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    assert.equal(validForegroundInput("acquire_control", { observation_id: id }), true);
    assert.equal(
      validForegroundInput("click", {
        lease_id: id,
        observation_id: id,
        point: { x: -300, y: 40 },
      }),
      true,
    );
    assert.equal(
      validForegroundInput("click", {
        lease_id: id,
        observation_id: id,
        point: { x: 1, y: 2 },
        pid: 42,
      }),
      false,
    );
    assert.equal(
      validForegroundInput("drag", {
        lease_id: id,
        observation_id: id,
        start: { x: 0, y: 0 },
        end: { x: 5000, y: 0 },
      }),
      false,
    );
    assert.equal(
      validForegroundInput("scroll", {
        lease_id: id,
        observation_id: id,
        point: { x: 0, y: 0 },
        delta_x: 0,
        delta_y: Infinity,
      }),
      false,
    );
    assert.equal(
      validForegroundInput("type_text", {
        lease_id: id,
        observation_id: id,
        text: "x".repeat(513),
      }),
      false,
    );
    assert.equal(
      validForegroundInput("key_press", {
        lease_id: id,
        observation_id: id,
        key: "arbitrary",
        modifiers: [],
      }),
      false,
    );
  });

  it("does not promote foreground delivery into application success", () => {
    const result = {
      operation: "click",
      mode: "EXCLUSIVE_FOREGROUND",
      route: "quartz_input",
      classification: "REQUIRES_FOREGROUND",
      effect: "unknown",
      input_delivery: "confirmed",
      application_effect: "unknown",
      evidence: [{ kind: "input_delivery", observed_by_tap: true }],
    };
    assert.deepEqual(normalizeComputerUseResult(result, "click"), result);
    assert.equal(
      normalizeComputerUseResult({ ...result, operation: undefined }, "click").effect,
      "failed",
    );
    assert.equal(
      normalizeComputerUseResult({ ...result, effect: "confirmed" }, "click").effect,
      "failed",
    );
    assert.equal(
      normalizeComputerUseResult({ ...result, classification: "BACKGROUND_SAFE" }, "click").effect,
      "failed",
    );
  });
});
