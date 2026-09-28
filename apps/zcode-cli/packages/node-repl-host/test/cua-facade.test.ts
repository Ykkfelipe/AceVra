/**
 * Host-installed `agent.computerUse` facade.
 *
 * The computer-use skill's contract is that the shared node_repl host installs the client before
 * every cell and the model starts from `agent.computerUse`; the plugin's
 * `scripts/computer-use-client.mjs` is only the compatibility bootstrap. Packaged acceptance of the
 * managed-helper capability work showed the whole credential chain healthy
 * (`node-repl socket=true token=true`) while the model still reported "Computer Use is not
 * available", because the bridge was reachable only through its symbol and the facade was never
 * installed. These tests lock the installation, its merge semantics, and the fail-closed refusal
 * when no usable transport exists.
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/node-repl-host/test/cua-facade.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createComputerUseBridgeGlobals,
  prepareComputerUseRuntimeGlobals,
} from "../src/cua-bridge.js";

function globalsWithBroker(broker: { socketPath: string; token: string } | undefined, calls: string[] = []) {
  const globals: Record<PropertyKey, unknown> = {};
  const getActiveCall = () => ({
    generation: 1,
    requestMeta: { runtime_scope: "main", session_id: "sess_test", workspace_path: "/tmp/ws" },
    signal: new AbortController().signal,
  });
  Object.assign(
    globals,
    createComputerUseBridgeGlobals({
      ...(broker ? { broker } : {}),
      generation: 1,
      getActiveCall,
      session: () => ({ mergeResponseMeta: () => undefined, recordCuaAppIdentity: () => undefined }) as never,
      documentationRoot: "/plugin/docs",
    }),
  );
  void calls;
  return globals;
}

test("the host installs agent.computerUse from the captured bridge", () => {
  const globals = globalsWithBroker({ socketPath: "/tmp/b.sock", token: "t" });
  prepareComputerUseRuntimeGlobals(globals);
  const agent = (globals as Record<string, unknown>).agent as Record<string, unknown>;
  assert.ok(agent, "agent global must exist");
  assert.equal(typeof agent.computerUse, "object");
  assert.equal(
    (agent.computerUse as { documentationRoot?: unknown }).documentationRoot,
    "/plugin/docs",
    "documentationRoot is part of the skill-facing facade",
  );
});

test("existing agent capabilities survive the installation (browsers stays usable)", () => {
  const globals = globalsWithBroker({ socketPath: "/tmp/b.sock", token: "t" });
  const browsers = { marker: "browsers" };
  (globals as Record<string, unknown>).agent = { browsers };
  prepareComputerUseRuntimeGlobals(globals);
  const agent = (globals as Record<string, unknown>).agent as Record<string, unknown>;
  assert.equal(agent.browsers, browsers, "the facade must merge, never replace, agent");
  assert.ok(agent.computerUse, "and still install computerUse");
});

test("without a captured bridge the installer is a no-op", () => {
  const globals: Record<PropertyKey, unknown> = {};
  prepareComputerUseRuntimeGlobals(globals);
  assert.equal((globals as Record<string, unknown>).agent, undefined);
});

test("a session without a broker still exposes the facade and fails closed on use", async () => {
  const globals = globalsWithBroker(undefined);
  prepareComputerUseRuntimeGlobals(globals);
  const agent = (globals as Record<string, unknown>).agent as Record<string, unknown>;
  const computerUse = agent.computerUse as Record<string, (input?: unknown) => Promise<unknown>>;
  await assert.rejects(
    () => computerUse.list_apps(),
    /Computer Use is unavailable for this node_repl session/,
  );
});
