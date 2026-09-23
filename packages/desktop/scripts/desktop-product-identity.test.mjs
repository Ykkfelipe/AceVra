import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_ZCODE_PROTOCOL_SCHEME,
  desktopProductIdentities,
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelIdForFlavor,
} from "./desktop-product-identity.mjs";
import { DEV_ELECTRON_APP_BUNDLE_ID, DEV_ELECTRON_APP_NAME } from "./devElectronAppBundle.mjs";

test("AceVra product identities remain isolated from the original app", () => {
  assert.equal(desktopProductIdentities.production.productName, "AceVra");
  assert.equal(desktopProductIdentities.production.appId, "dev.acevra.app");
  assert.equal(desktopProductIdentities.development.productName, "AceVra Dev");
  assert.equal(desktopProductIdentities.development.appId, "dev.acevra.app.development");
  assert.equal(desktopProductIdentities.preview.productName, "AceVra Preview");
  assert.equal(desktopProductIdentities.preview.appId, "dev.acevra.app.preview");
  assert.equal(desktopProductIdentities.preview.linuxPackageName, "acevra-preview");
  assert.equal(DEV_ELECTRON_APP_NAME, desktopProductIdentities.development.productName);
  assert.equal(DEV_ELECTRON_APP_BUNDLE_ID, desktopProductIdentities.development.appId);
  assert.notEqual(desktopProductIdentities.production.linuxPackageName, "zcode");
  assert.equal(desktopProductIdentities.production.linuxPackageName, "acevra");
  assert.equal(LEGACY_ZCODE_PROTOCOL_SCHEME, "zcode");
  assert.notEqual(
    desktopProductIdentities.development.appId,
    desktopProductIdentities.production.appId,
  );
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("production"),
    desktopProductIdentities.production.appId,
  );
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("production", { isPackaged: false }),
    desktopProductIdentities.development.appId,
  );
});

test("production backend selects AceVra and test backend selects AceVra Preview", () => {
  assert.equal(resolveDesktopProductIdentity({ ZCODE_ENV: "production" }).productName, "AceVra");
  assert.equal(resolveDesktopProductIdentity({ ZCODE_ENV: "test" }).productName, "AceVra Preview");
});
