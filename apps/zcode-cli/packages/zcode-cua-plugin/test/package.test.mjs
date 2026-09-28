import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  getComputerUseClient,
  setupComputerUseRuntime,
} from "../scripts/computer-use-client.mjs";
import { isOfficialCuaPluginEnabledForWorkspace } from "../../../../../packages/zcode-cua/broker-server.js";

const pluginRoot = resolve(import.meta.dirname, "..");
const requiredAssets = [
  ".zcode-plugin/plugin.json",
  "package.json",
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
];

async function writePluginConfig(root, enabled, { legacy = false, suppressed = false } = {}) {
  const zcodeHome = join(root, ".zcode");
  await mkdir(join(zcodeHome, "cli"), { recursive: true });
  await writeFile(
    join(zcodeHome, "cli", "config.json"),
    JSON.stringify({
      plugins: {
        enabledPlugins: {
          [legacy ? "zcode-cua@zcode-plugins-official" : "computer-use@zcode-plugins-official"]: enabled,
        },
        ...(suppressed
          ? { suppressedBuiltins: ["computer-use@zcode-plugins-official"] }
          : {}),
      },
    }),
  );
  return zcodeHome;
}

test("the documented bootstrap path resolves to the sanctioned packaged module", async () => {
  // The skill and docs name the bootstrap relative to the *plugin package root*. The model resolves
  // a skill's relative paths from the skill directory, so a document that leaves the base implicit
  // sends it looking under `skills/computer-use/scripts/` — which does not exist — and it then has to
  // search for an alternative (observed in packaged acceptance). Lock the three facts that make the
  // documented path unambiguous and satisfiable only by this package.
  const bootstrapRelativePath = "scripts/computer-use-client.mjs";
  const skill = await readFile(join(pluginRoot, "skills", "computer-use", "SKILL.md"), "utf8");
  const docs = await readFile(join(pluginRoot, "docs", "computer-use.md"), "utf8");
  const packageJson = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));

  for (const [label, text] of [
    ["skill", skill],
    ["docs", docs],
  ]) {
    assert.ok(text.includes(bootstrapRelativePath), `${label} must name ${bootstrapRelativePath}`);
    assert.ok(
      text.includes("plugin package root"),
      `${label} must state the bootstrap's base directory`,
    );
    assert.equal(
      text.includes("skills/computer-use/scripts/"),
      false,
      `${label} must not send the model to a skill-relative scripts path`,
    );
  }

  // The documented path is the package's own entry point, so it is the sanctioned module and it is
  // resolvable from the packaged root.
  assert.equal(packageJson.main, `./${bootstrapRelativePath}`);
  assert.equal(packageJson.exports["."], `./${bootstrapRelativePath}`);
  const module = await import(join(pluginRoot, bootstrapRelativePath));
  assert.equal(typeof module.setupComputerUseRuntime, "function");
  assert.equal(typeof module.getComputerUseClient, "function");
});

test("official Computer Use package contains the complete seed contract", async () => {
  for (const relativePath of requiredAssets) {
    await assert.doesNotReject(readFile(join(pluginRoot, relativePath), "utf8"));
  }
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  const packageJson = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "computer-use");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(packageJson.name, "@zcode/zcode-cua-plugin");
  assert.equal(packageJson.main, "./scripts/computer-use-client.mjs");
});

test("Computer Use is default-off and follows canonical or legacy plugin state", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cua-plugin-test-"));
  try {
    const zcodeHome = join(root, ".zcode");
    await mkdir(join(zcodeHome, "cli"), { recursive: true });
    await writeFile(join(zcodeHome, "cli", "config.json"), "{}");
    const env = { HOME: root, ZCODE_HOME: zcodeHome };
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env }), false);

    await writePluginConfig(root, true, { legacy: true });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env }), true);

    await writePluginConfig(root, true, { suppressed: true });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env }), false);

    await writePluginConfig(root, true);
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, ".zcode"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".zcode", "config.json"),
      JSON.stringify({
        plugins: { enabledPlugins: { "computer-use@zcode-plugins-official": false } },
      }),
    );
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({ env, workingDirectory: workspaceRoot }),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client bootstraps the host facade without constructing native CUA", async () => {
  const client = { name: "host-owned" };
  const globals = { agent: { computerUse: client } };
  assert.equal(getComputerUseClient(globals), client);
  assert.equal(setupComputerUseRuntime(globals), client);
  assert.throws(() => getComputerUseClient({ agent: {} }), /unavailable/i);

  const bridge = {
    assertAvailable: () => undefined,
    call: async (method, input) => ({ method, input }),
    documentationRoot: "/plugins/zcode-cua-plugin/docs",
  };
  const bridgeGlobals = { [Symbol.for("zcode.node-repl.computer-use-bridge")]: bridge };
  const bridgeClient = setupComputerUseRuntime(bridgeGlobals);
  assert.deepEqual(await bridgeClient.get_app_state({ app: "fixture" }), {
    method: "get_app_state",
    input: { app: "fixture" },
  });

  const source = await readFile(
    join(pluginRoot, "scripts", "computer-use-client.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /from ["']@zcode\/zcode-cua/);
  assert.doesNotMatch(source, /createComputerUseRuntime|startHelper|createCuaBrokerHost/);
});

test("bootstrap definition points at the real source package and required seed paths", async () => {
  const source = await readFile(
    resolve(pluginRoot, "../bootstrap/src/app/official-plugin-definitions.ts"),
    "utf8",
  );
  assert.match(source, /apps\/zcode-cli\/packages\/zcode-cua-plugin/);
  for (const requiredPath of [
    "docs/computer-use.md",
    "scripts/computer-use-client.mjs",
    "skills/computer-use/SKILL.md",
  ]) {
    assert.match(source, new RegExp(requiredPath.replace(/[/.]/g, "\\$&")));
  }
  assert.match(source, /OFFICIAL_CUA_PLUGIN_ID/);
  assert.doesNotMatch(source, /computer-use[^\n]*defaultEnabled:\s*true/);
});
