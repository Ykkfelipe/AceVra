import { CoreErrorType, createCoreError, type ExecutionTargetPort } from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";

export const MAX_MODEL_BYTES = 40_000;

export function requirePort(context: ToolExecutionContext, toolName: string): ExecutionTargetPort {
  if (context.executionTargetPort) return context.executionTargetPort;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `${toolName} is not available: this host cannot run tasks on other devices`,
    { context: { toolCallId: context.toolCallId, toolName }, recoverable: false },
  );
}

export function failure(toolName: string, message: string, context: ToolExecutionContext): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    context: { toolCallId: context.toolCallId, toolName },
    recoverable: true,
  });
}

export function callContext(context: ToolExecutionContext) {
  return { turnId: context.turnId, toolCallId: context.toolCallId };
}

function formatModelContent(output: unknown): string {
  return JSON.stringify(output);
}

export const shared = {
  formatModelContent,
  resultBudget: {
    maxInlineBytes: MAX_MODEL_BYTES,
    maxModelBytes: MAX_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: { maxBytes: MAX_MODEL_BYTES, direction: "tail" as const },
  },
  trace: {
    required: true as const,
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  },
};
