/**
 * Screen takeover approval (zcode-cua specs "Screen takeover"): the projection raises the
 * Allow/Deny card only for the current task's pending request, and the card writes the decision
 * through the UI-owned `decideTakeover` only.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/cuaScreenTakeoverCard.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CuaComputerUseSessionView } from "@zcode/services";
import { register } from "node:module";
import {
  TID_V4_COMPUTER_USE_BAR_TAKEOVER,
  TID_V4_COMPUTER_USE_BAR_TAKEOVER_ALLOW,
  TID_V4_COMPUTER_USE_BAR_TAKEOVER_DENY,
} from "@zcode/shared";

register("./uiAssetStubLoader.mjs", import.meta.url);

const { projectComputerUseBar } = await import("../src/lib/cuaSessionProjection.js");
const { ComputerUseBar } = await import("../src/v4/composer/ComputerUseBar.js");
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { default: enUS } = await import("../src/i18n/locales/en-US.js");

const NOW = 1_000_000;

function session(
  takeover?: { state: "pending" | "granted" | "denied"; task: string },
  paused = false,
) {
  return {
    present: true,
    sessionId: "session-a",
    paused,
    stopMeaningful: false,
    lease: { state: "inactive" },
    activity: {
      callId: "call-1",
      task: "turn-1",
      method: "acquire_control",
      phase: "started",
      startedAt: NOW - 1_000,
    },
    ...(takeover ? { takeover: { ...takeover, requestedAt: NOW - 500 } } : {}),
  } as CuaComputerUseSessionView;
}

const project = (view: CuaComputerUseSessionView, currentTurnId = "turn-1") =>
  projectComputerUseBar({
    session: view,
    turnRunning: true,
    pending: null,
    now: NOW,
    currentTurnId,
  });

test("pending request for the current task raises the card", () => {
  const view = project(session({ state: "pending", task: "turn-1" }));
  assert.equal(view.visible, true);
  assert.equal(view.takeoverPending, true);
});

test("no card for another task's request, a decided request, or while paused", () => {
  assert.equal(project(session({ state: "pending", task: "turn-0" })).takeoverPending, false);
  assert.equal(project(session({ state: "granted", task: "turn-1" })).takeoverPending, false);
  assert.equal(project(session({ state: "denied", task: "turn-1" })).takeoverPending, false);
  assert.equal(project(session({ state: "pending", task: "turn-1" }, true)).takeoverPending, false);
  assert.equal(project(session()).takeoverPending, false);
});

test("card renders Allow and Deny instead of the bar", () => {
  const decisions: string[] = [];
  const view = project(session({ state: "pending", task: "turn-1" }));
  const html = renderToStaticMarkup(
    React.createElement(
      ZCodeIntlProvider,
      { locale: "en-US", messages: enUS },
      React.createElement(ComputerUseBar, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session: { view, decideTakeover: (d: string) => decisions.push(d) } as any,
        turnRunning: true,
        onStop: () => undefined,
      }),
    ),
  );
  assert.match(html, new RegExp(`data-testid="${TID_V4_COMPUTER_USE_BAR_TAKEOVER}"`, "u"));
  assert.match(html, new RegExp(`data-testid="${TID_V4_COMPUTER_USE_BAR_TAKEOVER_ALLOW}"`, "u"));
  assert.match(html, new RegExp(`data-testid="${TID_V4_COMPUTER_USE_BAR_TAKEOVER_DENY}"`, "u"));
  assert.match(html, /AceVra wants to use your screen/u);
  assert.match(html, /press Esc to take back control/u);
  assert.deepEqual(decisions, [], "rendering never decides");
});
