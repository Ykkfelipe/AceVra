import type { PersonaSpec } from "@zcode/dynamic-workflow";
import type { AgentRuntimeConfig } from "@zcode/core";
import { workflowActorToolPolicy } from "./workflow-actor-tools.js";

/** Frozen admission policy is reconstructed by the existing journal/replay path. */
export function multitaskActorPolicy(persona: PersonaSpec): Partial<AgentRuntimeConfig> {
  const worker = persona.worker;
  if (!worker) return {};
  return {
    ...(worker.modelSelection ? { modelSelection: worker.modelSelection } : {}),
    ...(worker.maxTurns ? { maxTurns: worker.maxTurns } : {}),
    mode: worker.permissionMode ?? "auto",
    toolAllowlist: worker.tools,
    toolDisallowlist: [
      ...workflowActorToolPolicy().toolDisallowlist,
      ...(worker.disallowedTools ?? []),
      // M1 是浅层协调；子 worker 不得绕过 subagents.enabled 再开编排或恢复其他 run。
      "Agent",
      "Task",
      "Workflow",
      "ResumeWorkflowRun",
      "SaveWorkflow",
    ],
  };
}
