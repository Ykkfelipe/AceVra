// Screen takeover glow markup + payload parsing (zcode-cua specs "Screen takeover").
// Run: mise exec -- node --import tsx --test packages/desktop/src/main/screenTakeoverOverlayHtml.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HINT,
  parseScreenTakeoverOverlayPayload,
  screenTakeoverOverlayHtml,
} from "./screenTakeoverOverlayHtml.js";

test("malformed payloads hide the overlay", () => {
  for (const payload of [undefined, null, "on", 1, {}, { active: "true" }]) {
    assert.equal(parseScreenTakeoverOverlayPayload(payload).active, false);
  }
});

test("text is bounded and falls back to defaults", () => {
  const parsed = parseScreenTakeoverOverlayPayload({
    active: true,
    label: "x".repeat(500),
    hint: " ",
  });
  assert.equal(parsed.active, true);
  assert.equal(parsed.label?.length, 120);
  assert.equal(parsed.hint, DEFAULT_HINT);
});

test("markup escapes text, has no script, and only the primary display gets the pill", () => {
  const html = screenTakeoverOverlayHtml({
    withPill: true,
    label: '<img src=x onerror="alert(1)">',
    hint: "Esc",
  });
  assert.doesNotMatch(html, /<script|<img/iu);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u);
  assert.match(html, /class="pill"/u);
  assert.match(html, /prefers-reduced-motion/u);
  assert.doesNotMatch(
    screenTakeoverOverlayHtml({ withPill: false, label: "a", hint: "b" }),
    /class="pill"/u,
  );
});
