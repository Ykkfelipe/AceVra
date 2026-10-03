// Local engineering alpha data isolation.
//
// Run: mise exec -- node --import tsx --test packages/services/test/localAlphaHomeIsolation.test.ts
//
// Every direct-HOME reader (commands, skills, settings sync, skill sync, subagents, hooks,
// plugin sync, CLI config/CUA detection, CUA install candidates) must resolve user-level paths
// through getUserHomeDir(), so one ZCODE_HOME override moves them all together. A reader that
// still used HOME directly would keep reading the production ~/.zcode inside an alpha install.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentStorageEnv, getUserHomeDir, getUserZCodeDir } from "../src/paths.js";
import { hasGlobalCliZCodeCuaServer } from "../src/node.js";
import { resolveModelIODirs } from "../src/zcode-agent/modelTrajectoryFileTail.js";
import {
  resolveHelperAppCandidate,
  resolvePeerIdentityProbe,
} from "../src/cua-permission-broker/darwinCuaHelperTransport.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "acevra-alpha-home-"));
}

test("ZCODE_HOME is the canonical user-level override for every direct reader", () => {
  const profileHome = tempDir();
  const env = {
    HOME: "/production-home",
    ZCODE_HOME: join(profileHome, ".zcode"),
  } as NodeJS.ProcessEnv;
  assert.equal(getUserHomeDir(env), profileHome);
  assert.equal(getUserZCodeDir(env), join(profileHome, ".zcode"));
  // Explicit HOME wins only when no ZCODE_HOME is configured.
  assert.equal(getUserHomeDir({ HOME: "/production-home" }), "/production-home");
});

test("alpha readers never observe a production CLI config sentinel", () => {
  const profileHome = tempDir();
  const productionHome = tempDir();
  mkdirSync(join(productionHome, ".zcode", "cli"), { recursive: true });
  writeFileSync(
    join(productionHome, ".zcode", "cli", "config.json"),
    JSON.stringify({ mcp: { servers: { "zcode-cua": { command: "production-sentinel" } } } }),
  );
  mkdirSync(join(profileHome, ".zcode", "cli"), { recursive: true });
  writeFileSync(join(profileHome, ".zcode", "cli", "config.json"), JSON.stringify({}));

  const env = {
    HOME: productionHome,
    ZCODE_HOME: join(profileHome, ".zcode"),
  } as NodeJS.ProcessEnv;
  assert.equal(getUserZCodeDir(env), join(profileHome, ".zcode"));
  assert.equal(hasGlobalCliZCodeCuaServer(env), false);
  const productionConfig = JSON.parse(
    readFileSync(join(productionHome, ".zcode", "cli", "config.json"), "utf8"),
  );
  assert.equal(productionConfig.mcp.servers["zcode-cua"].command, "production-sentinel");
});

test("model trajectory roots use the canonical user home without production fallback", () => {
  const profileHome = tempDir();
  const env = {
    HOME: "/production-home",
    ZCODE_HOME: join(profileHome, ".zcode"),
  } as NodeJS.ProcessEnv;
  const previousHome = process.env.HOME;
  const previousZcodeHome = process.env.ZCODE_HOME;
  process.env.HOME = env.HOME;
  process.env.ZCODE_HOME = env.ZCODE_HOME;
  try {
    const dirs = resolveModelIODirs();
    assert.equal(
      dirs.some((directory) => directory.includes("/production-home")),
      false,
    );
    assert.equal(
      dirs.some((directory) => directory.startsWith(profileHome)),
      true,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousZcodeHome === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = previousZcodeHome;
  }
});

test("CUA helper and probe resolve under the alpha computer-use root", () => {
  const profileHome = tempDir();
  const alphaZcodeHome = join(profileHome, ".zcode");
  const devRoot = join(alphaZcodeHome, "computer-use", "dev");
  mkdirSync(devRoot, { recursive: true });
  mkdirSync(join(devRoot, "AceVra Computer Use Dev.app"), { recursive: true });
  writeFileSync(join(devRoot, "peer-identity-probe"), "");

  const productionHome = tempDir();
  mkdirSync(join(productionHome, ".zcode", "computer-use", "dev"), { recursive: true });

  const env = { HOME: productionHome, ZCODE_HOME: alphaZcodeHome } as NodeJS.ProcessEnv;
  assert.equal(resolveHelperAppCandidate(env), join(devRoot, "AceVra Computer Use Dev.app"));
  assert.equal(resolvePeerIdentityProbe(env), join(devRoot, "peer-identity-probe"));
});

test("explicit Dev Helper path is used exactly; probe shares its directory", () => {
  const root = tempDir();
  const app = join(root, "AceVra Computer Use Dev.app");
  mkdirSync(app);
  writeFileSync(join(root, "peer-identity-probe"), "");
  const env = { ZCODE_CUA_BUNDLED_HELPER_APP_PATH: app };
  assert.equal(resolveHelperAppCandidate(env), app);
  assert.equal(resolvePeerIdentityProbe(env), join(root, "peer-identity-probe"));
  assert.equal(
    resolveHelperAppCandidate({ ...env, ZCODE_CUA_PACKAGED_RESOURCES_DIR: join(root, "missing") }),
    null,
  );
  assert.equal(
    resolveHelperAppCandidate({ ZCODE_CUA_BUNDLED_HELPER_APP_PATH: join(root, "missing.app") }),
    null,
  );
});

// 2026-10-03 实测：设了 ZCODE_HOME 的 profile（AceVra Dev、local alpha）里 Agent CLI 仍写共享
// 的 ~/.zcode/cli，已安装 ZCode.app 覆盖 node-repl-host 插件缓存 → `agent is not defined`。
test("an explicit ZCODE_HOME profile moves the agent CLI storage with it", () => {
  assert.deepEqual(buildAgentStorageEnv({ ZCODE_HOME: "/profile/.zcode", HOME: "/home" }), {
    ZCODE_STORAGE_DIR: "/profile/.zcode",
  });
  assert.deepEqual(
    buildAgentStorageEnv({ ZCODE_HOME: "/profile/.zcode", ZCODE_STORAGE_DIR: "/explicit" }),
    {},
    "an explicit storage dir wins",
  );
  assert.deepEqual(buildAgentStorageEnv({ HOME: "/home" }), {}, "default HOME keeps CLI defaults");
  assert.deepEqual(buildAgentStorageEnv({ ZCODE_HOME: "/not-a-zcode-dir" }), {});
});
