import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { register } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { ModelSettingsFixtureHarness } =
  await import("../src/settings/model-provider-section/ModelSettingsFixtureHarness.js");

function renderScenario(scenario: string): string {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <ModelSettingsFixtureHarness initialScenario={scenario} />
    </ZCodeIntlProvider>,
  );
}

test("fixtures render production presentations without live service providers", () => {
  const codex = renderScenario("CODEX_CONNECTED");
  assert.match(codex, /5-hour remaining/u);
  assert.match(codex, /Weekly remaining/u);
  assert.match(codex, /provider requests: 0/u);

  const claude = renderScenario("CLAUDE_CONNECTED");
  assert.match(claude, /Connected/u);
  assert.doesNotMatch(claude, /Quota remaining|5-hour remaining|Weekly remaining/u);

  const commandCode = renderScenario("COMMAND_CODE_CONFIGURED");
  assert.match(commandCode, /Default model:.*deepseek\/deepseek-v4-flash/su);
  assert.match(commandCode, /Context window \(1,000,000 tokens\)/u);

  const zaiHealthy = renderScenario("ZAI_HEALTHY");
  const zaiPartial = renderScenario("ZAI_PARTIAL_PLAN_FAILURE");
  assert.match(zaiHealthy, /Authenticated/u);
  assert.match(zaiPartial, /Plan details unavailable/u);
  assert.match(zaiPartial, /5-hour usage/u);
  assert.match(zaiPartial, /Weekly usage/u);
  assert.doesNotMatch(zaiPartial, /role="alert"|text-destructive/u);

  const navigation = renderScenario("NAVIGATION");
  assert.equal((navigation.match(/aria-label="Command Code"/g) ?? []).length, 1);
  assert.match(navigation, /Providers/u);
  assert.match(navigation, /Connected accounts \/ execution/u);
});

test("fixture module has no runtime service, provider hook, credential, or OAuth dependency", async () => {
  const source = await readFile(
    new URL(
      "../src/settings/model-provider-section/ModelSettingsFixtureHarness.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["']@\/hooks\//u);
  assert.doesNotMatch(source, /accountsService|credential|OAuth|fetch\s*\(/iu);
});
