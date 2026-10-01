import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import {
  createIsolatedRoots,
  startInferenceFixture,
  SENTINEL_KEY,
} from "../e2e/onboarding-fixture.mjs";

test("first-run roots are isolated and stay within Unix socket bounds", async () => {
  const first = await createIsolatedRoots();
  const second = await createIsolatedRoots();
  try {
    assert.notEqual(first.root, second.root);
    assert.notEqual(first.profile, first.userData);
    assert.ok(Buffer.byteLength(join(first.userData, "host-xxxxxxxxxxxxxxxx.sock")) < 100);
  } finally {
    await Promise.all(
      [first.root, second.root].map((root) => rm(root, { recursive: true, force: true })),
    );
  }
});
test("loopback inference requires only the non-secret sentinel and supports streaming", async () => {
  const fixture = await startInferenceFixture();
  try {
    const result = await fetch(`${fixture.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SENTINEL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "acevra-fixture", stream: true, messages: [] }),
    });
    assert.match(await result.text(), /AceVra fixture inference complete/);
    assert.deepEqual(fixture.requests, [{ model: "acevra-fixture", stream: true }]);
    assert.equal((await fetch(`${fixture.origin}/api/catalog`)).status, 503);
  } finally {
    await fixture.close();
  }
});
