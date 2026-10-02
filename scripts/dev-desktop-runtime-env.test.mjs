import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopDevRuntimeEnvironment as create } from "./dev-desktop-runtime-env.mjs";

test("foreign runtime identity is removed before every dev child", () => {
  const inherited = {
    PATH: "/bin",
    HTTP_PROXY: "http://proxy.test",
    CUSTOM: "keep",
    ZCODE_CUA_LAUNCHER_PID: "123",
    ZCODE_RUNTIME_ENV: "production",
    ZCODE_CUA_BUNDLED_HELPER_APP_PATH: "/Applications/ZCode.app/Contents/Resources/helper.app",
    ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/old/socket",
    ZCODE_CUA_PERMISSION_BROKER_TOKEN: "old",
    ZCODE_CUA_PLUGIN_AUTHORITY: "old",
    ZCODE_CUA_LEASE_AUTHORITY_SOCKET: "/old/lease",
    ZCODE_PLUGIN_ROOT: "/old/plugin",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/old/provider",
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/old/personal",
    ZCODE_BUILD_COMMIT_ID: "old",
    ZCODE_AGENT_SERVER_COMMAND: "/old/runtime",
    ZCODE_AGENT_SERVER_ARGS_JSON: "[]",
    ZCODE_AGENT_SERVER_CWD: "/old/cwd",
    ZCODE_HOME: "/old/home",
    ZCODE_BASE_URL: "https://foreign.test",
    ZCODE_TOOL_ENV_PASSTHROUGH_JSON: "{}",
    ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
  };
  const original = { ...inherited };
  const env = create(inherited);
  for (const key of Object.keys(inherited)) {
    if (
      [
        "PATH",
        "HTTP_PROXY",
        "CUSTOM",
        "ZCODE_RUNTIME_ENV",
        "ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL",
      ].includes(key)
    )
      continue;
    if (key === "ZCODE_CUA_BUNDLED_HELPER_APP_PATH") {
      assert.ok(
        env[key].endsWith(
          "/.zcode-fork-cua-home/.zcode/computer-use/dev/AceVra Computer Use Dev.app",
        ),
      );
    } else assert.equal(env[key], undefined, key);
  }
  assert.equal(env.HTTP_PROXY, inherited.HTTP_PROXY);
  assert.equal(env.ZCODE_RUNTIME_ENV, "development");
  assert.equal(env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL, "1");
  assert.deepEqual(inherited, original);
});

test("clean-shell deliberate overrides and repository config survive", () => {
  const env = create({
    ZCODE_BASE_URL: "http://mock.test",
    ZCODE_HOME: "/test/home",
    ZCODE_CUA_DEV_MODE: "1",
    ZCODE_E2E_COVERAGE: "1",
  });
  assert.equal(env.ZCODE_BASE_URL, "http://mock.test");
  assert.equal(env.ZCODE_HOME, "/test/home");
  assert.equal(env.ZCODE_E2E_COVERAGE, "1");
  assert.equal(env.ZCODE_CUA_DEV_MODE, "1");
  const local = create(
    { ZCODE_CUA_LAUNCHER_PID: "123", ZCODE_BASE_URL: "https://foreign.test" },
    {
      ZCODE_BASE_URL: "http://local.test",
      ZCODE_HOME: "/local/home",
      ZCODE_CUA_LAUNCHER_PID: "456",
    },
    "test",
  );
  assert.equal(local.ZCODE_BASE_URL, "http://local.test");
  assert.equal(local.ZCODE_HOME, "/local/home");
  assert.equal(local.ZCODE_CUA_LAUNCHER_PID, undefined);
  assert.equal(local.ZCODE_ENV, "test");
  assert.equal(local.ZCODE_RUNTIME_ENV, "development");
});

test("installed resource paths identify foreign parents without a launcher PID", () => {
  const env = create({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/Applications/ZCode.app/Contents/Resources/provider.json",
    ZCODE_BASE_URL: "https://foreign.test",
  });
  assert.equal(env.ZCODE_BASE_URL, undefined);
});

test("deliberate clean-shell Helper/provider paths remain testable", () => {
  const input = {
    ZCODE_CUA_BUNDLED_HELPER_APP_PATH: "/test/Dev.app",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/test/provider.json",
  };
  const env = create(input);
  for (const [key, value] of Object.entries(input)) assert.equal(env[key], value);
  const local = create({ ZCODE_CUA_LAUNCHER_PID: "123" }, input);
  for (const [key, value] of Object.entries(input)) assert.equal(local[key], value);
});

test("local Helper admission defaults to the builder artifact, without copying per profile", () => {
  assert.equal(
    create({ ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "true" }, {}, "production", "/developer")
      .ZCODE_CUA_BUNDLED_HELPER_APP_PATH,
    "/developer/.zcode-fork-cua-home/.zcode/computer-use/dev/AceVra Computer Use Dev.app",
  );
  assert.equal(
    create({}, {}, "production", "/developer").ZCODE_CUA_BUNDLED_HELPER_APP_PATH,
    undefined,
  );
});

test("process config overrides take precedence over local defaults in a clean shell", () => {
  assert.equal(
    create(
      { ZCODE_BASE_URL: "http://explicit.test", ZCODE_AGENT_SERVER_COMMAND: "/test/runtime" },
      { ZCODE_BASE_URL: "http://local.test" },
    ).ZCODE_BASE_URL,
    "http://explicit.test",
  );
  assert.equal(
    create({ ZCODE_AGENT_SERVER_COMMAND: "/test/runtime" }).ZCODE_AGENT_SERVER_COMMAND,
    "/test/runtime",
  );
});
