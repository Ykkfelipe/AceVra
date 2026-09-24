import assert from "node:assert/strict";
import test from "node:test";
import type { PluginMetadata } from "@zcode/contracts";

import { resolveBuiltInNodeReplMcpServers } from "../src/app/built-in-node-repl.js";
import { resolvePluginRuntimeFeatures } from "../src/app/plugin-runtime-features.js";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
} from "../src/app/official-plugin-definitions.js";

const plugin = (id: string, enabled: boolean, rootPath: string): PluginMetadata =>
  ({ id, enabled, rootPath }) as unknown as PluginMetadata;
const hostPlugin = plugin(OFFICIAL_NODE_REPL_HOST_PLUGIN_ID, true, "/plugins/node-repl-host");
const cuaPlugin = plugin(OFFICIAL_CUA_PLUGIN_ID, true, "/plugins/zcode-cua-plugin");

test("Computer Use runtime features follow the loaded enabled plugin", () => {
  assert.deepEqual(resolvePluginRuntimeFeatures({ plugins: [cuaPlugin] }), {
    computerUse: true,
  });
  assert.deepEqual(
    resolvePluginRuntimeFeatures({
      plugins: [{ ...cuaPlugin, enabled: false }],
    }),
    {},
  );
  assert.deepEqual(
    resolvePluginRuntimeFeatures({
      plugins: [{ ...cuaPlugin, id: OFFICIAL_BROWSER_USE_PLUGIN_ID, enabled: false }],
    }),
    {},
  );
});

test("node_repl registration uses the CUA plugin root and fails closed without its host", () => {
  const servers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome: { plugins: [cuaPlugin, hostPlugin] },
    workingDirectory: "/workspace",
  });
  assert.equal(
    (servers.node_repl as { env?: Record<string, string> }).env?.ZCODE_CUA_PLUGIN_ROOT,
    "/plugins/zcode-cua-plugin",
  );
  assert.equal(
    resolveBuiltInNodeReplMcpServers({
      pluginOutcome: { plugins: [cuaPlugin] },
      workingDirectory: "/workspace",
    }).node_repl,
    undefined,
  );
});
