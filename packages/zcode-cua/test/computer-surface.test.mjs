/**
 * Canonical model-visible Computer Use surface: one table, discovery via describe(), and refusals
 * that state the expected shape (the measured cause of minutes of API guessing).
 *
 * Run: node --test packages/zcode-cua/test/computer-surface.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { COMPUTER_USE_MODEL_TO_METHOD, resolveComputerUseMethod } from "../capability-contract.js";
import { COMPUTER_USE_SURFACE } from "../computer-surface.js";
import { createComputerUseRuntime } from "../index.js";

const LOCAL = {
  sessionId: "s",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
};

test("every documented name is callable and every callable name is documented", () => {
  for (const entry of COMPUTER_USE_SURFACE)
    assert.ok(resolveComputerUseMethod(entry.name), entry.name);
  for (const name of Object.keys(COMPUTER_USE_MODEL_TO_METHOD)) {
    assert.ok(
      COMPUTER_USE_SURFACE.some((entry) => entry.name === name),
      name,
    );
  }
  // 两个历史别名：无歧义地落到同一语义动作。
  assert.equal(resolveComputerUseMethod("press"), "press");
  assert.equal(resolveComputerUseMethod("set_value"), "set_value");
  assert.equal(resolveComputerUseMethod("type_text"), undefined);
});

test("describe() reports the exact surface, this session's availability, and the limits", async () => {
  const background = createComputerUseRuntime({
    platform: "darwin",
    allowForegroundControl: () => false,
  });
  const described = await background.execute({ toolName: "describe", context: LOCAL });
  const surface = described.structuredContent;
  assert.equal(surface.foregroundAvailable, false);
  const press = surface.methods.find((entry) => entry.name === "computer.press");
  assert.equal(press.args, "{ semantic_ref: string }");
  assert.equal(press.available, true);
  assert.equal(
    surface.methods.find((entry) => entry.name === "computer.key_press").available,
    false,
  );
  assert.ok(surface.limits.some((limit) => /no background Enter/u.test(limit)));
  assert.ok(surface.limits.some((limit) => /osascript/u.test(limit)));
  const foreground = createComputerUseRuntime({
    platform: "darwin",
    allowForegroundControl: () => true,
  });
  const local = await foreground.execute({ toolName: "describe", context: LOCAL });
  assert.equal(local.structuredContent.foregroundAvailable, true);
  const subagent = await foreground.execute({
    toolName: "describe",
    context: { ...LOCAL, runtimeScope: "subagent" },
  });
  assert.equal(subagent.structuredContent.foregroundAvailable, false);
});

test("refusals name the expected arguments instead of 'arguments are invalid'", async () => {
  const runtime = createComputerUseRuntime({
    platform: "darwin",
    allowForegroundControl: () => true,
  });
  const key = await runtime.execute({
    toolName: "computer.key_press",
    arguments: { key: "return" },
    context: LOCAL,
  });
  assert.match(key.content[0].text, /lease_id, observation_id, key: return/u);
  assert.match(key.content[0].text, /acquire_control/u);
  const press = await runtime.execute({
    toolName: "computer.press",
    arguments: {},
    context: LOCAL,
  });
  assert.match(press.content[0].text, /semantic_ref: string/u);
  const unknown = await runtime.execute({ toolName: "computer", arguments: {}, context: LOCAL });
  assert.match(unknown.content[0].text, /computer\.workspace_click/u);
  assert.match(unknown.content[0].text, /describe\(\)/u);
});

test("open_app is documented background capability and refuses a missing bundle_id", async () => {
  const runtime = createComputerUseRuntime({
    platform: "darwin",
    allowForegroundControl: () => false,
  });
  const described = await runtime.execute({ toolName: "describe", context: LOCAL });
  const openApp = described.structuredContent.methods.find(
    (entry) => entry.name === "computer.open_app",
  );
  assert.ok(openApp, "open_app must be in the documented surface");
  assert.equal(openApp.kind, "background");
  assert.equal(openApp.available, true);
  assert.match(openApp.note, /running windowless/u);

  const missing = await runtime.execute({
    toolName: "computer.open_app",
    arguments: {},
    context: LOCAL,
  });
  assert.match(missing.content[0].text, /bundle_id: string/u);
  const empty = await runtime.execute({
    toolName: "computer.open_app",
    arguments: { bundle_id: "   " },
    context: LOCAL,
  });
  assert.match(empty.content[0].text, /bundle_id: string/u);
});
