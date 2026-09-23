import assert from "node:assert/strict";
import test from "node:test";
import { resolveProductionRemoteAssetCacheDir } from "./dev-desktop-remote-prod.mjs";

test("remote-production development cache is isolated under AceVra Dev", () => {
  assert.equal(
    resolveProductionRemoteAssetCacheDir({}, "darwin", "/Users/tester"),
    "/Users/tester/Library/Application Support/AceVra Dev/remote-assets-cache",
  );
  assert.equal(
    resolveProductionRemoteAssetCacheDir({}, "win32", "C:\\Users\\tester"),
    "C:\\Users\\tester\\AppData\\Roaming\\AceVra Dev\\remote-assets-cache",
  );
  assert.equal(
    resolveProductionRemoteAssetCacheDir({}, "linux", "/home/tester"),
    "/home/tester/.config/AceVra Dev/remote-assets-cache",
  );
});
