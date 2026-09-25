import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationTransport } from "../src/v4/transport.js";
import { createBackendRoutingConversationTransport } from "../src/v4/backendRoutingConversationTransport.js";

function makeTransport(name: string, calls: string[]): ConversationTransport {
  return {
    async subscribe() { throw new Error(`${name}.subscribe unused`); },
    activate() {}, async resync() { throw new Error("unused"); }, async unsubscribe() {},
    async sendCommand(envelope) { calls.push(`${name}:${envelope.sessionId}`); return { commandId: "cmd", status: "accepted", revisionAtDecision: 1 }; },
    async queryCommands() { return { results: [] }; }, async rowsRange() { throw new Error("unused"); },
    async plans() { throw new Error("unused"); }, async workflowRunEvents() { throw new Error("unused"); },
    async workflowRuns() { throw new Error("unused"); }, async workflowRunArtifacts() { throw new Error("unused"); },
    async workflowRunArtifactData() { throw new Error("unused"); }, async workflowRunArtifactRead() { throw new Error("unused"); },
    async workflowRunWorkspace() { throw new Error("unused"); }, async workflowRunNodeResult() { throw new Error("unused"); },
    async fileChanges() { throw new Error("unused"); }, async fileRewindPreview() { throw new Error("unused"); },
    async attachmentPut() { throw new Error("unused"); }, async attachmentRead() { throw new Error("unused"); },
    async attachmentReadRange() { throw new Error("unused"); }, onFrame() { return () => {}; },
    onAssemblyFault() { return () => {}; }, onRuntimeRestart() { return () => {}; }, onRuntimeLifecycle() { return () => {}; },
  } as ConversationTransport;
}

test("routes persisted Codex identity by workspace scope and sends through Codex", async () => {
  const calls: string[] = [];
  const lookups: Array<{ taskId: string; workspaceIdentity?: string }> = [];
  const agent = makeTransport("agent", calls);
  const codex = makeTransport("codex", calls);
  const routeAlpha = createBackendRoutingConversationTransport({
    agent, codex, workspaceIdentity: "workspace-alpha",
    async isCodexTask(identity) { lookups.push(identity); return identity.workspaceIdentity === "workspace-alpha"; },
  });
  const routeBeta = createBackendRoutingConversationTransport({
    agent, codex, workspaceIdentity: "workspace-beta",
    async isCodexTask(identity) { lookups.push(identity); return identity.workspaceIdentity === "workspace-alpha"; },
  });
  const envelope = { sessionId: "same-task-id", commandId: "cmd", type: "sendText", payload: { text: "after migration" } } as never;
  await routeAlpha.sendCommand(envelope);
  await routeBeta.sendCommand(envelope);
  assert.deepEqual(lookups, [
    { taskId: "same-task-id", workspaceIdentity: "workspace-alpha" },
    { taskId: "same-task-id", workspaceIdentity: "workspace-beta" },
  ]);
  assert.deepEqual(calls, ["codex:same-task-id", "agent:same-task-id"]);
});
