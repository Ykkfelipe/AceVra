import {
  MULTITASK_TOOL_NAME,
  MultitaskInputJsonSchema,
  MultitaskInputSchema,
  MultitaskResolvedInputSchema,
} from "@zcode/contracts";
import { formatModelPickerValue } from "@zcode/shared/model-selection";
import type { AgentProfile } from "../../subagent/profile.js";
import { normalizeAgentProfiles } from "../../subagent/profile.js";
import type { ToolEntry } from "../types.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { buildMultitaskScript } from "./multitask-graph.js";
import { resolveModelReference } from "./model-reference.js";
import { clampWorkflowMaxConcurrency } from "./create-workflow-source.js";

export function createMultitaskToolEntry(profiles: readonly AgentProfile[] = []): ToolEntry {
  const active = normalizeAgentProfiles(profiles);
  return {
    ...createWorkflowToolEntry,
    capability: "Submit a bounded one-off task graph through the Workflow runtime",
    metadata: {
      ...createWorkflowToolEntry.metadata,
      name: MULTITASK_TOOL_NAME,
      description: `Use ONLY when the user explicitly requests Multitask or parallel workers. Plan the minimum useful set of 1–4 workers and explicit task dependencies; submit this structured graph without writing a Workflow script. Available Subagent profiles: ${active.map((profile) => `${profile.name}: ${profile.description}`).join("; ")}. Read workers run concurrently with conservative read tools; writers run exclusively in the shared checkout. No nested delegation. Use scoped task prompts and sharedContext for common facts. Workers may choose a model from ListModels; otherwise use the profile or parent model. Skills, scoped MCP and memory profiles are unsupported in M1. Workers must submit an explicit result per task; completion returns, by task ID, {outcome, result, evidence}. outcome is one of done (declared done and backed by observed tool use), done_no_changes (writer made no changes), unverified (claimed done with no observed tool use), blocked, failed (no result submitted or the ask failed) or skipped (a dependency did not finish). Only done is evidence-backed: never present the others as success. Synthesize a coherent final answer yourself, do not add report-writing workers. Workflow remains available for explicit repeatable scripts.`,
    },
    inputSchema: MultitaskInputJsonSchema,
    runtimeInputSchema: MultitaskInputSchema.extend({
      script: MultitaskResolvedInputSchema.shape.script.optional(),
      max_concurrency: MultitaskResolvedInputSchema.shape.max_concurrency.optional(),
    }),
    validateInput: undefined,
    resolveInput: async (raw, context) => {
      try {
        const input = MultitaskInputSchema.parse(raw);
        const frozen = active.map((profile) => ({ ...profile }));
        // Resolve worker model overrides against the same catalog before approval.
        const workerProfiles = input.workers.map((worker) => {
          const profile = frozen.find(
            (entry) => entry.name === (worker.profile ?? "general-purpose"),
          );
          if (!profile) throw new Error(`Unknown Subagent profile: ${worker.profile}`);
          const requested =
            worker.model ??
            (profile.modelSelection ? formatModelPickerValue(profile.modelSelection) : undefined);
          let modelSelection = profile.modelSelection;
          if (requested !== undefined) {
            if (!context.modelCatalogPort)
              throw new Error("This host cannot choose a worker model");
            const resolved = resolveModelReference(
              requested,
              context.modelCatalogPort.listModels(),
            );
            if (!resolved.ok) throw new Error(resolved.message);
            modelSelection = resolved.selection;
          }
          return [worker.id, { ...profile, modelSelection }] as const;
        });
        const script = buildMultitaskScript(input, frozen, new Map(workerProfiles));
        return {
          result: true,
          input: {
            ...input,
            script,
            max_concurrency: clampWorkflowMaxConcurrency(
              input.workers.length,
              context.dynamicWorkflowRunPort?.concurrencyCeiling?.(),
            ),
          },
        };
      } catch (error) {
        return {
          result: false,
          errorCode: 400,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    prepareApproval: (input) => {
      const resolved = MultitaskResolvedInputSchema.parse(input);
      return createWorkflowToolEntry.prepareApproval!({
        name: resolved.name,
        script: resolved.script,
        max_concurrency: resolved.max_concurrency,
      });
    },
    handler: async (input, context) => {
      const resolved = MultitaskResolvedInputSchema.parse(input);
      const output = await createWorkflowToolEntry.handler(
        { name: resolved.name, script: resolved.script, max_concurrency: resolved.max_concurrency },
        context,
      );
      return {
        ...(output as object),
        response: `${(output as { response: string }).response}\nMultitask: when the run completes, synthesize the task results into one coherent answer. Check each task outcome; only "done" is backed by observed tool use, so report unverified, blocked, failed or skipped tasks honestly.`,
      };
    },
    permission: {
      ...createWorkflowToolEntry.permission,
      reason: "multitask.runConfirmation: confirm the planned workers and dependencies",
    },
  };
}

export const multitaskToolEntry = createMultitaskToolEntry();
