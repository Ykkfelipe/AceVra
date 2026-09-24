import assert from "node:assert/strict";
import test from "node:test";

import { openPermissionSettingsWithFallback } from "./cuaPermissionSettingsFallback.js";

test("permission onboarding falls back to the broader Privacy & Security surface", async () => {
  const opened: string[] = [];
  const fallbackUsed = await openPermissionSettingsWithFallback({
    permission: "accessibility",
    openSettingsUrl: async (url) => {
      opened.push(url);
      if (opened.length === 1) throw new Error("specific pane was unavailable");
    },
  });
  assert.equal(fallbackUsed, true);
  assert.deepEqual(opened, [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "x-apple.systempreferences:com.apple.preference.security",
  ]);
});

test("permission onboarding propagates a typed launch failure when fallback also fails", async () => {
  await assert.rejects(
    () =>
      openPermissionSettingsWithFallback({
        permission: "screen_recording",
        openSettingsUrl: async () => {
          throw new Error("System Settings launch failed");
        },
      }),
    /System Settings launch failed/,
  );
});
