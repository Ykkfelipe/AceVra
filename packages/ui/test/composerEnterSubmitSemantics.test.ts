/**
 * Pins the composer Enter contract: bare Enter sends, Shift+Enter stays a newline.
 *
 * Phase 6 context: a browser drill appeared to show Enter-to-send broken in the `/fork`
 * mobile shell. It was a harness artifact — the automation sent the key name "Return",
 * which never reached the page at all, so nothing handled it. The product path was always
 * correct. These tests exist so that the distinction is checked in CI instead of being
 * re-litigated through a browser, and so a future rebind or default change cannot silently
 * turn bare Enter into a newline.
 *
 * The shortcut kernel imports through the `@/` Vite alias, which plain node+tsx cannot
 * resolve, so this file needs the ui tsconfig:
 *
 *   TSX_TSCONFIG_PATH=packages/ui/tsconfig.json \
 *     mise exec -- node --import tsx --test packages/ui/test/composerEnterSubmitSemantics.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_COMMANDS } from "@zcode/shared";
import {
  resolveComposerKeyAction,
  shouldBareEnterFallThroughToNewline,
} from "../src/shortcuts/composerShortcuts.js";
import { resolveEffectiveShortcutBindings } from "../src/shortcuts/bindings.js";

const enter = { key: "Enter", code: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
const shiftEnter = { ...enter, shiftKey: true };

test("composerSend still defaults to bare Enter", () => {
  const send = SHORTCUT_COMMANDS.find((c) => c.id === "composerSend");
  assert.ok(send, "composerSend command must exist");
  assert.deepEqual([...send.defaultBindings], ["Enter"]);
});

test("with defaults resolved, bare Enter is a send and does not fall through to newline", () => {
  const effective = resolveEffectiveShortcutBindings(undefined);
  assert.equal(resolveComposerKeyAction(enter, effective), "send");
  assert.equal(shouldBareEnterFallThroughToNewline(effective), false);
});

test("Shift+Enter is never resolved as a send", () => {
  const effective = resolveEffectiveShortcutBindings(undefined);
  assert.notEqual(resolveComposerKeyAction(shiftEnter, effective), "send");
});

test("an absent shortcut override still yields Enter-to-send", () => {
  // The web/relay shell reads bindings from the settings snapshot, which can be undefined
  // before settings load. That must behave like defaults, not like "user unbound Enter".
  const effective = resolveEffectiveShortcutBindings({});
  assert.equal(resolveComposerKeyAction(enter, effective), "send");
  assert.equal(shouldBareEnterFallThroughToNewline(effective), false);
});

test("an explicit empty composerSend override does unbind bare Enter", () => {
  // Deliberate rebind-away is the one case where bare Enter becomes a newline.
  const effective = resolveEffectiveShortcutBindings({ composerSend: [] });
  assert.equal(shouldBareEnterFallThroughToNewline(effective), true);
});

test("rebinding send to Ctrl+Enter releases bare Enter to newline", () => {
  const effective = resolveEffectiveShortcutBindings({ composerSend: ["Ctrl+Enter"] });
  assert.equal(shouldBareEnterFallThroughToNewline(effective), true);
  assert.equal(resolveComposerKeyAction({ ...enter, ctrlKey: true }, effective), "send");
});
