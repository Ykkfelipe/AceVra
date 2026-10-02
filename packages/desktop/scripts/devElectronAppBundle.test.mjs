import assert from "node:assert/strict";
import test from "node:test";
import { ensureDevElectronBundleSignature } from "./devElectronAppBundle.mjs";

test("valid cached dev bundle needs no signing", async () => {
  const calls = [];
  await ensureDevElectronBundleSignature("/dev/App.app", async (...args) => calls.push(args));
  assert.deepEqual(calls, [
    ["/usr/bin/codesign", ["--verify", "--deep", "--strict", "/dev/App.app"]],
  ]);
});

test("invalid dev seal is repaired with entitlements preserved, then strictly verified", async () => {
  const calls = [];
  await ensureDevElectronBundleSignature("/dev/App.app", async (command, args) => {
    calls.push([command, args]);
    if (calls.length === 1) throw new Error("invalid seal");
  });
  assert.deepEqual(calls[0], calls[2]);
  assert.deepEqual(calls[1], [
    "/usr/bin/codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--preserve-metadata=entitlements,flags,runtime",
      "/dev/App.app",
    ],
  ]);
});

test("failed repair or verification blocks dev startup", async () => {
  for (const failAt of [2, 3]) {
    let calls = 0;
    await assert.rejects(
      ensureDevElectronBundleSignature("/dev/App.app", async () => {
        calls++;
        if (calls === 1 || calls === failAt) throw new Error("invalid seal");
      }),
      /invalid seal/,
    );
    assert.equal(calls, failAt);
  }
});
