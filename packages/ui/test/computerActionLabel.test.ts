/**
 * M3: product-owned Computer action labels are the single display source for both the
 * transcript and the MiniComputerPanel. A known Computer method always resolves to a
 * deterministic, localized product label — never the model's reasoning-language text.
 *
 * Also covers the js-cell path: Computer Use runs as an `mcp__node_repl__js` cell whose input
 * carries a model-authored `title`, so the display model must suppress that title once the
 * cell's structured result identifies a known Computer operation.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/computerActionLabel.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

const { computerActionMessageId, computerActionMethodFromOperation, formatComputerActionLabel } =
  await import("../src/lib/computerActionLabel.js");
const { buildNodeReplDisplayModel } = await import("../src/lib/nodeReplToolDisplay.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default;

/** Minimal react-intl-compatible stub over the real en-US catalog. */
const intl = {
  formatMessage(input: { id: string }, values?: Record<string, string>): string {
    let text = (enUS as Record<string, string>)[input.id] ?? input.id;
    if (values) {
      for (const [key, value] of Object.entries(values)) {
        text = text.replaceAll(`{${key}}`, value);
      }
    }
    return text;
  },
};

const known = Object.freeze({
  list_apps: "Viewing running apps",
  list_windows: "Viewing windows",
  get_app_state: "Observing",
  observe: "Observing",
  screenshot: "Capturing screenshot",
  workspace_click: "Clicking",
  click: "Clicking",
  workspace_type_text: "Typing",
  type_text: "Typing",
  scroll: "Scrolling",
  press: "Pressing",
  activate_target: "Opening",
  acquire_control: "Taking exclusive desktop control",
  release_control: "Returning desktop control",
});

test("known Computer methods resolve to deterministic English product labels", () => {
  for (const [method, expected] of Object.entries(known)) {
    assert.equal(
      formatComputerActionLabel(intl, method),
      expected,
      `${method} should render the product label, not model text`,
    );
  }
});

test("both facade spellings of a method map to the SAME label", () => {
  assert.equal(formatComputerActionLabel(intl, "click"), "Clicking");
  assert.equal(formatComputerActionLabel(intl, "workspace_click"), "Clicking");
  assert.equal(formatComputerActionLabel(intl, "type_text"), "Typing");
  assert.equal(formatComputerActionLabel(intl, "workspace_type_text"), "Typing");
});

test("a known method with a Chinese/model-authored title still renders the product label", () => {
  // The model might have narrated a tool-call `title` in Chinese; product-owned label wins.
  const modelChineseTitle = "查看正在运行的应用";
  assert.notEqual(formatComputerActionLabel(intl, "list_apps"), modelChineseTitle);
  assert.equal(formatComputerActionLabel(intl, "list_apps"), "Viewing running apps");
});

test("acquire_control uses explicit foreground-control wording", () => {
  assert.equal(
    formatComputerActionLabel(intl, "acquire_control"),
    "Taking exclusive desktop control",
  );
  assert.equal(computerActionMessageId("acquire_control"), "chat.computerAction.acquireControl");
});

test("unknown methods fall back to a stable generic label, never model text", () => {
  assert.equal(formatComputerActionLabel(intl, "totally_unknown_tool_xyz"), "Computer action");
});

/**
 * A js cell: the model writes `input.title` in its own reasoning language, and the cell's
 * structured result carries the Computer operation. The operation is the only trusted signal.
 */
function jsCell(
  overrides: {
    title?: string;
    result?: unknown;
    toolName?: string;
  } = {},
): Parameters<typeof buildNodeReplDisplayModel>[0] {
  return {
    toolId: "tool-1",
    toolName: overrides.toolName ?? "mcp__node_repl__js",
    kind: "js",
    input: { code: "const s = await agent.computerUse.observe()", title: overrides.title },
    output: "done",
    status: "completed",
    raw: { result: overrides.result },
  } as unknown as Parameters<typeof buildNodeReplDisplayModel>[0];
}

test("a known Computer operation in a js cell suppresses the model's title", () => {
  const model = buildNodeReplDisplayModel(
    jsCell({ title: "查找全局电脑对象", result: { operation: "click", effect: "confirmed" } }),
  );
  assert.equal(model.computerOperation, "click");
  assert.equal(model.userTitle, undefined);
  assert.equal(formatComputerActionLabel(intl, model.computerOperation ?? ""), "Clicking");
});

test("the operation is read from the live raw.result AND the terminal snapshot shape", () => {
  // 实时 tool.updated：display 与结果都在 raw.result 内。
  const live = buildNodeReplDisplayModel(
    jsCell({ title: "查看屏幕", result: { operation: "observe" } }),
  );
  assert.equal(live.computerOperation, "observe");
  assert.equal(live.userTitle, undefined);

  // 终态 snapshot：completed part 的 metadata 直接作为 raw，operation 在顶层。
  const terminal = buildNodeReplDisplayModel({
    toolId: "tool-2",
    toolName: "mcp__node_repl__js",
    kind: "js",
    input: { code: "x", title: "Looking at Chrome" },
    status: "completed",
    raw: { operation: "screenshot", display: { kind: "node_repl_images" } },
  } as unknown as Parameters<typeof buildNodeReplDisplayModel>[0]);
  assert.equal(terminal.computerOperation, "screenshot");
  assert.equal(terminal.userTitle, undefined);
});

test("every known Computer operation name maps to a product label, in all three spellings", () => {
  const expectations: ReadonlyArray<[string, string]> = [
    ["observe", "Observing"],
    ["screenshot", "Capturing screenshot"],
    ["click", "Clicking"],
    ["left_click", "Clicking"],
    ["type", "Typing"],
    ["type_text", "Typing"],
    ["workspace_click", "Clicking"],
    ["workspace_type_text", "Typing"],
    ["scroll", "Scrolling"],
    ["press", "Pressing"],
    ["set_value", "Setting value"],
    ["key_press", "Pressing key"],
    ["move", "Moving pointer"],
    ["move_pointer", "Moving pointer"],
    ["drag", "Dragging"],
    ["open", "Opening"],
    ["open_application", "Opening"],
    ["activate_target", "Opening"],
    ["wait", "Waiting"],
    ["acquire_control", "Taking exclusive desktop control"],
    ["release_control", "Returning desktop control"],
    ["permission_status", "Requesting permissions"],
    ["control_status", "Checking control status"],
    ["list_apps", "Viewing running apps"],
    ["list_windows", "Viewing windows"],
    ["get_app_state", "Observing"],
    ["read_clipboard", "Reading clipboard"],
    ["write_clipboard", "Writing to clipboard"],
    ["zoom", "Zooming"],
  ];
  for (const [operation, expected] of expectations) {
    const method = computerActionMethodFromOperation(operation);
    assert.ok(method, `${operation} must be a known Computer operation`);
    assert.equal(formatComputerActionLabel(intl, method), expected, operation);
  }
});

test("facade and legacy prefixed operation names normalize to the same method", () => {
  assert.equal(computerActionMethodFromOperation("computer.click"), "click");
  assert.equal(computerActionMethodFromOperation("mcp__computer_use__left_click"), "left_click");
  assert.equal(
    computerActionMethodFromOperation("mcp__plugin_zcode_cua_computer_use__type_text"),
    "type_text",
  );
  assert.equal(computerActionMethodFromOperation("mcp__computer-use__key_press"), "key_press");
  assert.equal(computerActionMethodFromOperation("  CLICK  "), "click");
});

test("an unknown operation keeps the sanitized model title — no blanking of non-computer cells", () => {
  const unknown = buildNodeReplDisplayModel(
    jsCell({ title: "Summarise the release notes", result: { operation: "custom_thing" } }),
  );
  assert.equal(unknown.computerOperation, undefined);
  assert.equal(unknown.userTitle, "Summarise the release notes");

  // 旧 IMPLEMENTATION_TITLE_PATTERN 仍照常过滤实现性标题。
  const implementation = buildNodeReplDisplayModel(
    jsCell({ title: "Run this in the JS node repl", result: { operation: "custom_thing" } }),
  );
  assert.equal(implementation.userTitle, undefined);

  // 没有 result 的普通 cell 完全不受影响。
  const plain = buildNodeReplDisplayModel(jsCell({ title: "Summarise the release notes" }));
  assert.equal(plain.computerOperation, undefined);
  assert.equal(plain.userTitle, "Summarise the release notes");
});

test("a js cell is never labelled as a terminal action", () => {
  for (const operation of ["run_shell", "bash", "execute", "terminal", "spawn"]) {
    assert.equal(computerActionMethodFromOperation(operation), undefined, operation);
  }
  const shellish = buildNodeReplDisplayModel(
    jsCell({ title: "Run the build", result: { operation: "run_shell" } }),
  );
  assert.equal(shellish.computerOperation, undefined);
  assert.equal(shellish.userTitle, "Run the build");
});

test("reset/configure cells never pick up a Computer operation", () => {
  const reset = buildNodeReplDisplayModel({
    toolId: "tool-3",
    toolName: "mcp__node_repl__js_reset",
    kind: "js_reset",
    input: {},
    status: "completed",
    raw: { operation: "click" },
  } as unknown as Parameters<typeof buildNodeReplDisplayModel>[0]);
  assert.equal(reset.operation, "reset");
  assert.equal(reset.computerOperation, undefined);
});
