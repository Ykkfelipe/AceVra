import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopProductIdentities,
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelIdForFlavor,
} from "./desktop-product-identity.mjs";

test("AceVra product identities remain isolated from the original app", () => {
  assert.equal(desktopProductIdentities.production.productName, "AceVra");
  assert.equal(desktopProductIdentities.production.appId, "com.acevra.desktop");
  assert.equal(desktopProductIdentities.preview.productName, "AceVra Preview");
  assert.equal(desktopProductIdentities.preview.appId, "com.acevra.desktop.preview");
  assert.notEqual(desktopProductIdentities.production.linuxPackageName, "zcode");
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("production"),
    desktopProductIdentities.production.appId,
  );
});

test("production backend selects AceVra and test backend selects AceVra Preview", () => {
  assert.equal(resolveDesktopProductIdentity({ ZCODE_ENV: "production" }).productName, "AceVra");
  assert.equal(resolveDesktopProductIdentity({ ZCODE_ENV: "test" }).productName, "AceVra Preview");
});
