/**
 * M3: product-owned Computer action labels are the single display source for both the
 * transcript and the MiniComputerPanel. A known Computer method always resolves to a
 * deterministic, localized product label — never the model's reasoning-language text.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/computerActionLabel.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

const { computerActionMessageId, formatComputerActionLabel } =
  await import("../src/lib/computerActionLabel.js");
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
