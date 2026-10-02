/**
 * Product rule: the right-side Computer pane is the REMOTE (SSH) computer surface only. Local Mac
 * Computer Use never appears there — background agent work on this Mac surfaces solely in the
 * floating mini Computer panel over the conversation (v4-mini-computer). This file pins that
 * boundary at the pane's own surface: the chooser offers no local/This-Mac entry, and no
 * "This Mac" label exists in either shipped locale.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/computerPaneSurface.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { register } from "node:module";

register("./uiAssetStubLoader.mjs", import.meta.url);

const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default;
const zhCN = (await import("../src/i18n/locales/zh-CN.js")).default;
const { PlatformProvider } = await import("../src/hooks/usePlatform.js");
const { ComputerPane } = await import("../src/computers/ComputerPane.js");

const DELL = {
  id: "dell",
  name: "Dell",
  host: "dell.local",
  port: 22,
  username: "agent",
};

/** Renders the un-chosen pane state; the chooser list is the surface under test. */
function renderChooser(): string {
  const platform = { computers: { list: async () => [DELL] } };
  return renderToStaticMarkup(
    React.createElement(
      ZCodeIntlProvider,
      { locale: "en-US", messages: enUS },
      React.createElement(
        PlatformProvider,
        // 仅提供 ComputerPane 在该状态下真正读取的 computers 面，其余按契约补空。
        { platform: platform as never },
        React.createElement(ComputerPane, {
          computerId: null,
          visible: true,
          expanded: false,
          onToggleExpand: () => undefined,
          onSelectComputer: () => undefined,
        }),
      ),
    ),
  );
}

test("the Computer pane chooser offers no local/This-Mac entry", () => {
  const html = renderChooser();
  assert.match(html, /computer-pane/);
  assert.match(html, /Choose a computer to view\./);
  assert.doesNotMatch(html, /This Mac/);
  assert.doesNotMatch(html, /local-mac/);
});

test("no shipped locale defines a Computer pane local entry label", () => {
  assert.equal(enUS["computers.panel.thisMac"], undefined);
  assert.equal(zhCN["computers.panel.thisMac"], undefined);
});
