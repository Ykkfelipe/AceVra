import {
  REMOTE_COMPUTER_TOOL_NAME,
  RemoteComputerInputJsonSchema,
  RemoteComputerInputSchema,
  RemoteComputerOutputJsonSchema,
  RemoteComputerOutputSchema,
  type ModelMessageContent,
  type RemoteComputerAction,
  type RemoteComputerInput,
  type RemoteComputerOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { describeExecutionTargetFailure } from "./execution-target-format.js";
import {
  MAX_MODEL_BYTES,
  callContext,
  failure,
  requirePort,
  shared,
} from "./execution-target-shared.js";

export function toRemoteComputerAction(input: RemoteComputerInput): RemoteComputerAction | string {
  const point = () =>
    input.x === undefined || input.y === undefined ? null : { x: input.x, y: input.y };
  switch (input.action) {
    case "screenshot":
      return { kind: "screenshot" };
    case "click":
    case "double_click":
    case "right_click": {
      const p = point();
      if (!p) return `${input.action} needs x and y (screen pixels from the last screenshot).`;
      return {
        kind: "click",
        ...p,
        ...(input.action === "right_click" ? { button: "right" as const } : {}),
        ...(input.action === "double_click" ? { double: true } : {}),
      };
    }
    case "move": {
      const p = point();
      return p ? { kind: "move", ...p } : "move needs x and y.";
    }
    case "drag": {
      const p = point();
      if (!p || input.toX === undefined || input.toY === undefined)
        return "drag needs x, y (start) and toX, toY (end).";
      return { kind: "drag", fromX: p.x, fromY: p.y, toX: input.toX, toY: input.toY };
    }
    case "scroll":
      if (input.dy === undefined) return "scroll needs dy (positive scrolls down).";
      return { kind: "scroll", dy: input.dy, ...point() };
    case "type":
      return input.text ? { kind: "type", text: input.text } : "type needs text.";
    case "key": {
      const keys = (input.keys ?? []).map((key) => key.trim().toLowerCase());
      if (keys.length === 0 || keys.some((key) => !/^[a-z0-9]{1,24}$/.test(key)))
        return "key needs keys like ['enter'] or ['ctrl','s'] (pyautogui names).";
      return { kind: "key", keys };
    }
  }
}

const remoteComputerHandler: ToolHandler = async (input, context) => {
  const parsed = RemoteComputerInputSchema.parse(input) as RemoteComputerInput;
  const port = requirePort(context, REMOTE_COMPUTER_TOOL_NAME);
  const action = toRemoteComputerAction(parsed);
  if (typeof action === "string") throw failure(REMOTE_COMPUTER_TOOL_NAME, action, context);
  const result = await port.computer({ targetId: parsed.targetId, action }, callContext(context));
  if (!result.ok) {
    throw failure(
      REMOTE_COMPUTER_TOOL_NAME,
      describeExecutionTargetFailure(result, { targetId: parsed.targetId }),
      context,
    );
  }
  const output: RemoteComputerOutput = {
    targetId: parsed.targetId,
    action: parsed.action,
    screen: result.screen,
    message:
      parsed.action === "screenshot"
        ? `Screenshot of ${result.screen.width}x${result.screen.height}. Coordinates for actions are pixels in this image.`
        : `Done. Take a screenshot to see the result.`,
    ...(result.image ? { image: result.image } : {}),
  };
  return output;
};

function formatRemoteComputerContent(output: unknown): ModelMessageContent {
  const parsed = RemoteComputerOutputSchema.safeParse(output);
  if (!parsed.success) return JSON.stringify(output);
  const { image, ...rest } = parsed.data;
  if (!image) return JSON.stringify(rest);
  return [
    { type: "text", text: JSON.stringify(rest) },
    {
      type: "image",
      mediaType: image.mimeType,
      dataUrl: `data:${image.mimeType};base64,${image.base64}`,
    },
  ];
}

const REMOTE_COMPUTER_MAX_BYTES = 10_000_000;

export const remoteComputerToolEntry: ToolEntry = {
  ...shared,
  formatModelContent: formatRemoteComputerContent,
  resultBudget: {
    maxInlineBytes: REMOTE_COMPUTER_MAX_BYTES,
    maxModelBytes: REMOTE_COMPUTER_MAX_BYTES,
    strategy: "truncate" as const,
    preview: { maxBytes: MAX_MODEL_BYTES, direction: "head" as const },
  },
  capability: "See and operate the screen of one of the user's SSH computers",
  metadata: {
    name: REMOTE_COMPUTER_TOOL_NAME,
    description: [
      "Sees and operates the screen of another of the user's computers reached over SSH (ExecutionTargets kind 'ssh' with capability computerUse), e.g. their Windows PC. The user watches it live in the Computer panel and can take control or stop you at any time.",
      "- Use it only when the user asked you to use that computer. Never for this Mac (local computer use stays as it is).",
      "- Start with action 'screenshot'; coordinates are pixels in that screenshot. Take another screenshot after actions to check the result.",
      "- If the user takes control or uses that computer, you are paused (error says so): wait and tell the user; do not retry in a loop.",
      "- Offline computers fail; nothing is ever done on this Mac instead.",
    ].join("\n"),
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 90_000,
    maxOutputBytes: REMOTE_COMPUTER_MAX_BYTES,
    sideEffectScope: "system",
    riskLevel: "medium",
    // 用户决定：使用自己的 SSH 电脑不需要逐次审批（面板始终可见，可随时接管/停止）。
    needsApproval: false,
  },
  handler: remoteComputerHandler,
  inputSchema: RemoteComputerInputJsonSchema,
  outputSchema: RemoteComputerOutputJsonSchema,
  runtimeInputSchema: RemoteComputerInputSchema,
  runtimeOutputSchema: RemoteComputerOutputSchema,
  permission: {
    permission: "executionTarget.computer",
    reason:
      "RemoteComputer operates the screen of the user's own SSH computer, visible live in the Computer panel",
    riskLevel: "medium",
    sideEffectScope: "system",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  timeout: { defaultMs: 90_000, maxMs: 90_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "RemoteComputer was cancelled",
  },
};
