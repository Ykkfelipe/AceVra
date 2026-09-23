import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { NodeReplSession } from "@zcode/core/repl";
import { createInProcessNodeReplExecutor } from "../src/server.js";
import { toMcpRunResult } from "../src/result.js";

test("static import declarations receive a structured diagnostic", async () => {
  for (const code of [
    'import x from "x";',
    'import { x } from "x";',
    `import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { setupBrowserRuntime } = await import('file:///browser-client.mjs');
return { ready: true };`,
  ]) {
    const run = await new NodeReplSession().run(code);
    assert.equal(run.error?.code, "node_repl_static_import_unsupported");
    assert.match(run.error.message, /Use await import\(\.\.\.\) instead/);
  }
});

test("dynamic import and import text do not trigger static-import preflight", async () => {
  const run = await new NodeReplSession().run(`
    // import x from "x";
    const text = 'import { x } from "x"';
    const path = await import("node:path");
    nodeRepl.write(text);
    const o = { import: "p" };
    const viaProperty = o.import;
    const viaTemplate = \`import x from "\${viaProperty}"\`;
    path.basename("/tmp/example");
  `);
  assert.equal(run.error, undefined);
  assert.equal(run.result, "example");
});

test("MCP browser JS has an initialized facade without model bootstrap", async () => {
  const previousPluginRoot = process.env.ZCODE_PLUGIN_ROOT;
  process.env.ZCODE_PLUGIN_ROOT = "/browser-plugin-test";
  try {
    const execute = createInProcessNodeReplExecutor();
    const run = await execute({
      code: "nodeRepl.write(typeof agent.browsers.list)",
      requestMeta: { runtime_scope: "main", session_id: "bootstrap-test" },
      signal: new AbortController().signal,
      syncTimeoutMs: 5_000,
    });
    assert.equal(run.error, undefined);
    assert.equal(
      toMcpRunResult(run).content.find((block) => block.type === "text")?.text,
      "function",
    );
  } finally {
    if (previousPluginRoot === undefined) delete process.env.ZCODE_PLUGIN_ROOT;
    else process.env.ZCODE_PLUGIN_ROOT = previousPluginRoot;
  }
});

test("older explicit browser plugin bootstrap remains compatible", async () => {
  const pluginRoot = new URL("../../browser-use-plugin/", import.meta.url);
  const previousPluginRoot = process.env.ZCODE_PLUGIN_ROOT;
  process.env.ZCODE_PLUGIN_ROOT = pluginRoot.pathname;
  try {
    const clientUrl = pathToFileURL(
      new URL("scripts/browser-client.mjs", pluginRoot).pathname,
    ).href;
    const run = await createInProcessNodeReplExecutor()({
      code: `const { setupBrowserRuntime } = await import(${JSON.stringify(clientUrl)});
await setupBrowserRuntime({ globals: globalThis });
nodeRepl.write(typeof agent.browsers.list);`,
      requestMeta: { runtime_scope: "main", session_id: "compatibility-test" },
      signal: new AbortController().signal,
      syncTimeoutMs: 5_000,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.logs, "function");
  } finally {
    if (previousPluginRoot === undefined) delete process.env.ZCODE_PLUGIN_ROOT;
    else process.env.ZCODE_PLUGIN_ROOT = previousPluginRoot;
  }
});

test("subagent Node REPL remains usable without a browser facade", async () => {
  const previousPluginRoot = process.env.ZCODE_PLUGIN_ROOT;
  process.env.ZCODE_PLUGIN_ROOT = "/browser-plugin-test";
  try {
    const run = await createInProcessNodeReplExecutor()({
      code: "nodeRepl.write(typeof globalThis.agent?.browsers)",
      requestMeta: { runtime_scope: "subagent", session_id: "subagent-test" },
      signal: new AbortController().signal,
      syncTimeoutMs: 5_000,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.logs, "undefined");
  } finally {
    if (previousPluginRoot === undefined) delete process.env.ZCODE_PLUGIN_ROOT;
    else process.env.ZCODE_PLUGIN_ROOT = previousPluginRoot;
  }
});
