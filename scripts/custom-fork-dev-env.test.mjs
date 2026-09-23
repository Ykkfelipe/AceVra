import assert from "node:assert/strict";
import test from "node:test";
import { createCustomForkDevEnvironment } from "./custom-fork-dev-env.mjs";

test("custom fork development entry points agree on the isolated root", () => {
  const desktop = createCustomForkDevEnvironment({}, "/Users/tester");
  const server = createCustomForkDevEnvironment({}, "/Users/tester");
  assert.equal(desktop.ZCODE_DATA_BASE_DIR, "/Users/tester/.zcode-fork-dev-home");
  assert.equal(desktop.ZCODE_DATA_BASE_DIR, server.ZCODE_DATA_BASE_DIR);
  assert.equal(desktop.ZCODE_HOME, "/Users/tester/.zcode-fork-dev-home/.zcode");
  assert.equal(server.ZCODE_FORK_SERVER_MODE, "relay-broker");
});

test("explicit custom data root and relay settings are preserved", () => {
  const resolved = createCustomForkDevEnvironment(
    {
      ZCODE_DATA_BASE_DIR: "/tmp/custom-fork-data",
      ZCODE_HOME: "/tmp/custom-fork-data/.zcode",
      ZCODE_FORK_RELAY_URL: "wss://relay.example.test",
      ZCODE_FORK_RELAY_DEVICE_TOKEN: "test-only-token",
    },
    "/Users/tester",
  );
  assert.equal(resolved.ZCODE_DATA_BASE_DIR, "/tmp/custom-fork-data");
  assert.equal(resolved.ZCODE_HOME, "/tmp/custom-fork-data/.zcode");
  assert.equal(resolved.ZCODE_FORK_RELAY_URL, "wss://relay.example.test");
  assert.equal(resolved.ZCODE_FORK_RELAY_DEVICE_TOKEN, "test-only-token");
});

test("an explicit ZCODE_HOME determines the default data base when it names .zcode", () => {
  const resolved = createCustomForkDevEnvironment(
    { ZCODE_HOME: "/tmp/fork-home/.zcode" },
    "/Users/tester",
  );
  assert.equal(resolved.ZCODE_DATA_BASE_DIR, "/tmp/fork-home");
});
