import assert from "node:assert/strict";
import test from "node:test";
import { selectAccountTokenStorage } from "./accountTokenStorage.js";

function fakeSecure() {
  const calls: string[] = [];
  const data = new Map<string, string>();
  return {
    calls,
    storage: {
      getItem: (k: string) => (calls.push("get"), data.get(k) ?? null),
      setItem: (k: string, v: string) => void (calls.push("set"), data.set(k, v)),
      removeItem: (k: string) => void (calls.push("remove"), data.delete(k)),
    },
  };
}

test("encryption available → secure persistence is selected and used", async () => {
  const secure = fakeSecure();
  const picked = selectAccountTokenStorage({
    probe: { isEncryptionAvailable: () => true },
    createSecure: () => secure.storage,
  });
  assert.equal(picked.persistent, true);
  await picked.storage.setItem("k", "v");
  assert.equal(await picked.storage.getItem("k"), "v");
  assert.deepEqual(secure.calls, ["set", "get"]);
});

test("encryption unavailable → memory-only and the secure implementation is never created or invoked", async () => {
  let created = 0;
  const secure = fakeSecure();
  const notes: string[] = [];
  const picked = selectAccountTokenStorage({
    probe: { isEncryptionAvailable: () => false },
    createSecure: () => (created++, secure.storage),
    diagnostic: (m) => notes.push(m),
  });
  assert.equal(picked.persistent, false);
  await picked.storage.setItem("k", "TOKEN");
  assert.equal(await picked.storage.getItem("k"), "TOKEN");
  await picked.storage.removeItem("k");
  assert.equal(await picked.storage.getItem("k"), null);
  assert.equal(created, 0, "no persistence/keychain code constructed");
  assert.deepEqual(secure.calls, []);
  assert.ok(notes.every((m) => !m.includes("TOKEN")));
});

test("a throwing availability probe is treated as unavailable", () => {
  const picked = selectAccountTokenStorage({
    probe: {
      isEncryptionAvailable: () => {
        throw new Error("keychain");
      },
    },
    createSecure: () => {
      throw new Error("must not run");
    },
  });
  assert.equal(picked.persistent, false);
});

test("a later secure failure fails closed to memory once, without retries or token logging", async () => {
  let attempts = 0;
  const notes: string[] = [];
  const picked = selectAccountTokenStorage({
    probe: { isEncryptionAvailable: () => true },
    createSecure: () => ({
      getItem: () => null,
      setItem: () => {
        attempts++;
        throw new Error("jwt eyJSECRET failed");
      },
      removeItem: () => {},
    }),
    diagnostic: (m) => notes.push(m),
  });
  await picked.storage.setItem("k", "eyJSECRET");
  await picked.storage.setItem("k2", "v2");
  assert.equal(attempts, 1, "no retry loop");
  assert.equal(await picked.storage.getItem("k"), "eyJSECRET", "kept in memory for this process");
  assert.equal(notes.length, 1);
  assert.ok(!notes[0]!.includes("eyJ"));
});
