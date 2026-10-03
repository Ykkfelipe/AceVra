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
    // 不在这里兜底成 "auto"：runtime 的 mode "auto" 尚未实现，会让冻结重放出来的 worker
    // 直接被权限层拒绝。留空时由 actor 创建路径沿用既有的模式继承。
    ...(worker.permissionMode ? { mode: worker.permissionMode } : {}),
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
