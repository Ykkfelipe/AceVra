import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import {
  isCuaComposerPluginError,
  resolveCuaComposerEntryView,
} from "../src/lib/cuaComposerEntryState.js";
import { shouldShowComputerUseAlphaNotice } from "../src/settings/computerUseReleaseNotice.js";

const OFFICIAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";

const visibleComposerInput = {
  macLocalDesktop: true,
  windowsLocalDesktop: false,
  hiddenBySettings: false,
  permissionServiceAvailable: true,
  pluginEnabled: true,
  pluginToggling: false,
  pluginError: false,
  permissionStatus: null,
  sessionBusy: false,
};

test("successful Computer Use enablement does not produce an error tooltip", () => {
  const view = resolveCuaComposerEntryView(visibleComposerInput);

  assert.deepEqual(view, {
    visible: true,
    uiState: "idle",
    tone: "subtle",
    spinning: false,
    tooltipMessageId: "chat.toolbar.computerUse.tooltip.idle",
    clickAction: "open-settings",
    interactionDisabled: false,
  });
});

test("only an official Computer Use plugin rejection produces the enablement error tooltip", () => {
  assert.equal(
    isCuaComposerPluginError(true, OFFICIAL_CUA_PLUGIN_ID, OFFICIAL_CUA_PLUGIN_ID),
    true,
  );
  assert.equal(isCuaComposerPluginError(true, "other-plugin", OFFICIAL_CUA_PLUGIN_ID), false);
  assert.equal(
    isCuaComposerPluginError(false, OFFICIAL_CUA_PLUGIN_ID, OFFICIAL_CUA_PLUGIN_ID),
    false,
  );

  const staleErrorAfterEnablement = resolveCuaComposerEntryView({
    ...visibleComposerInput,
    pluginError: true,
  });
  assert.equal(staleErrorAfterEnablement.visible, true);
  if (staleErrorAfterEnablement.visible) {
    assert.equal(staleErrorAfterEnablement.uiState, "idle");
    assert.equal(
      staleErrorAfterEnablement.tooltipMessageId,
      "chat.toolbar.computerUse.tooltip.idle",
    );
  }
});

test("the alpha notice remains visible while disabled or toggling and hides after confirmed enablement", () => {
  assert.equal(
    shouldShowComputerUseAlphaNotice({
      releaseProfile: "local-engineering-alpha",
      enabled: false,
      toggling: false,
    }),
    true,
  );
  assert.equal(
    shouldShowComputerUseAlphaNotice({
      releaseProfile: "local-engineering-alpha",
      enabled: true,
      toggling: true,
    }),
    true,
  );
  assert.equal(
    shouldShowComputerUseAlphaNotice({
      releaseProfile: "local-engineering-alpha",
      enabled: true,
      toggling: false,
    }),
    false,
  );
  assert.equal(
    shouldShowComputerUseAlphaNotice({
      releaseProfile: "other",
      enabled: false,
      toggling: false,
    }),
    false,
  );
});

test("the Computer Use failure copy points to Settings and does not prescribe an app restart", () => {
  assert.equal(
    enUS["chat.toolbar.computerUse.tooltip.error"],
    "Computer Use could not be enabled. Open Settings → Computer Use to retry; if it persists, inspect the plugin error.",
  );
  assert.equal(enUS["chat.toolbar.computerUse.tooltip.error"].includes("restart"), false);
});
