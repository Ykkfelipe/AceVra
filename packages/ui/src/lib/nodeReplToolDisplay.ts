import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";
import { findNodeReplComputerOperation } from "@/lib/nodeReplCuaOperation.js";
import {
  extractImages,
  findCuaApp,
  findObservationImages,
  hasBrowserTurnEndDisplay,
  hasComputerImageDisplay,
} from "@/lib/nodeReplDisplayScan.js";

export type NodeReplOperation = "run" | "reset" | "add-module-dir";

export interface NodeReplDisplayImage {
  base64: string;
  mimeType: string;
}

export interface NodeReplDisplayError {
  summary: string;
  stack?: string;
}

export interface NodeReplPersistedResult {
  artifactPath: string;
  sizeLabel: string;
}

/** 本次 cell 操作的目标应用（Computer Use）；由 CLI 的 node_repl display 携带。 */
export interface NodeReplCuaApp {
  appKey: string;
  displayName?: string;
}

export interface NodeReplDisplayModel {
  operation: NodeReplOperation;
  userTitle?: string;
  /**
   * 已识别的 Computer Use 操作（归一化方法名）。
   *
   * Computer Use 动作以 js cell 执行，这类 cell 不走 CUA 卡片而走 node_repl renderer；
   * 命中已知操作时产品标签必须胜出，模型自述的 `userTitle` 会被抑制。
   */
  computerOperation?: string;
  code?: string;
  moduleDirectory?: string;
  resultText?: string;
  error?: NodeReplDisplayError;
  images: NodeReplDisplayImage[];
  /**
   * 观察类截图（agent 自用，CUA-1.6）：display 侧与聊天可见 images 分流；只在工具详情
   * 折叠区渲染缩略图，绝不进对话主流。
   */
  observationImages?: NodeReplDisplayImage[];
  imagesInConversation?: boolean;
  persistedResult?: NodeReplPersistedResult;
  displaySource?: "browser_turn_end";
  app?: NodeReplCuaApp;
}

const IMPLEMENTATION_TITLE_PATTERN = /(?:\bjs\b|\bjavascript\b|node[\s_-]*repl)/i;
const LEADING_BLANK_LINES_PATTERN = /^(?:[ \t]*\r?\n)+/;
const PROJECTED_COMPLETION_MARKER_PATTERN = /(^|\n)=> /g;
const PROJECTED_IMAGE_PLACEHOLDER_PATTERN = /^\[Attached image\/[^\]]+\]$/u;
const PERSISTED_OUTPUT_PATTERN =
  /^<persisted-output>\s*\nOutput too large \(([^)]+)\)\. Full output saved to: ([^\n]+)\n\nPreview \([^)]+\):\n([\s\S]*?)\n<\/persisted-output>\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function readFirstStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = readNonEmptyString(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function readRawInput(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }

  return raw.rawInput ?? raw.input;
}

function readRawOutput(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }

  return raw.rawOutput ?? raw.output ?? raw.result;
}

function resolveOperation(toolCall: ChatToolCall): NodeReplOperation {
  const toolName = (toolCall.toolName?.trim() || toolCall.kind).toLowerCase();
  // 真实 MCP 工具会带 mcp__node_repl__ 前缀；仅匹配旧 built-in 名称
  // 会把 reset/configure 错误展示成执行 JavaScript。
  if (toolName === "js_reset" || toolName === "mcp__node_repl__js_reset") {
    return "reset";
  }
  if (
    toolName === "js_add_node_module_dir" ||
    toolName === "mcp__node_repl__js_add_node_module_dir"
  ) {
    return "add-module-dir";
  }
  return "run";
}

function parseInputRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readInputRecords(toolCall: ChatToolCall): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const candidate of [toolCall.input, readRawInput(toolCall.raw)]) {
    const record = parseInputRecord(candidate);
    if (record && !records.includes(record)) {
      records.push(record);
    }
  }

  return records;
}

function readUserTitle(
  toolCall: ChatToolCall,
  inputs: readonly Record<string, unknown>[],
): string | undefined {
  // 完成态快照可能只在 raw input 或顶层 title 保留用户标题，不能因主 input 只有 code 就丢失。
  for (const candidate of [...inputs.map((input) => input.title), toolCall.title]) {
    const title = readNonEmptyString(candidate)?.trim();
    if (title && !IMPLEMENTATION_TITLE_PATTERN.test(title)) {
      return title;
    }
  }

  return undefined;
}

function readInputString(
  inputs: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const input of inputs) {
    const value = readFirstStringField(input, keys);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }

  const directString = readNonEmptyString(value);
  if (directString) {
    return directString;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item, depth + 1))
      .filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "text") {
    const textValue = readFirstStringField(value, ["value", "text", "content"]);
    if (textValue) {
      return textValue;
    }
  }

  const logs = readNonEmptyString(value.logs);
  const result = extractText(value.result, depth + 1);
  if (logs || result) {
    return [logs, result].filter((item): item is string => item !== undefined).join("\n");
  }

  for (const key of ["value", "output", "text", "content", "stdout", "message"] as const) {
    const text = extractText(value[key], depth + 1);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function removeProjectedCompletionMarkers(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }

  // 结果投影会用“=> ”区分完成值与日志，但这是内部协议标记，不应展示给用户。
  return text.replace(PROJECTED_COMPLETION_MARKER_PATTERN, "$1");
}

function removeProjectedImagePlaceholders(
  text: string | undefined,
  hasImages: boolean,
): string | undefined {
  if (!text || !hasImages) return text;

  // Agent/Provider 需要图片的文本占位，但工具卡片已持有真实 display 图片；
  // 若继续渲染投影文本，用户会同时看到图片和“Attached MCP image”内部协议描述。
  const visibleLines = text
    .split("\n")
    .filter((line) => !PROJECTED_IMAGE_PLACEHOLDER_PATTERN.test(line.trim()));
  const withoutPlaceholder = visibleLines.join("\n").trim();
  return withoutPlaceholder === "(no output)" || withoutPlaceholder.length === 0
    ? undefined
    : withoutPlaceholder;
}

function removeLeadingBlankLines(code: string | undefined): string | undefined {
  if (!code) {
    return code;
  }

  // 模型生成的执行内容经常在首个有效行前带换行；只移除空白行，避免破坏代码缩进。
  return code.replace(LEADING_BLANK_LINES_PATTERN, "");
}

function extractError(value: unknown, depth = 0): NodeReplDisplayError | undefined {
  if (depth > 4) {
    return undefined;
  }

  if (typeof value === "string") {
    const summary = value.trim();
    return summary.length > 0 ? { summary } : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if ("error" in value) {
    const nested = extractError(value.error, depth + 1);
    if (nested) {
      return nested;
    }
  }

  const message = readFirstStringField(value, ["message", "errorText"]);
  const name = readNonEmptyString(value.name)?.trim();
  const stack = readNonEmptyString(value.stack);
  if (message) {
    const normalizedMessage = message.trim();
    return {
      summary:
        name && !normalizedMessage.startsWith(`${name}:`)
          ? `${name}: ${normalizedMessage}`
          : normalizedMessage,
      ...(stack ? { stack } : {}),
    };
  }

  return undefined;
}

function parsePersistedResult(text: string | undefined): {
  resultText?: string;
  persistedResult?: NodeReplPersistedResult;
} {
  if (!text) {
    return {};
  }

  const match = PERSISTED_OUTPUT_PATTERN.exec(text);
  if (!match) {
    return { resultText: text };
  }

  const [, sizeLabel, artifactPath, preview] = match;
  if (!sizeLabel || !artifactPath) {
    return { resultText: text };
  }

  return {
    ...(preview?.trim() ? { resultText: preview } : {}),
    persistedResult: {
      artifactPath: artifactPath.trim(),
      sizeLabel: sizeLabel.trim(),
    },
  };
}

export function buildNodeReplDisplayModel(toolCall: ChatToolCall): NodeReplDisplayModel {
  const inputs = readInputRecords(toolCall);
  const outputCandidates = [toolCall.output, readRawOutput(toolCall.raw)].filter(
    (value) => value !== undefined,
  );
  const projectedText = outputCandidates
    .map((candidate) => extractText(candidate))
    .find((candidate) => candidate !== undefined);
  // 实时 tool.updated 把 display 放在 raw.result 内，终态 snapshot 则把
  // completed part 的 metadata 直接作为 raw。只扫描 raw.result 会让对话结束后的图片消失。
  const images = extractImages([...outputCandidates, toolCall.raw]);
  const app = findCuaApp(toolCall.raw);
  // 只有 run 形态的 cell 会带 Computer Use 结果；reset/configure 的 raw 里出现同名
  // 字段也只是历史噪声，不应把「重置内核」显示成一次电脑操作。
  // 宿主记录的 operation 优先（覆盖 get_app_state 这类结果里没有 operation 字段的观察）；
  // 结果里的 operation 字段只作为该字段出现之前持久化的历史行的回退。
  const computerOperation =
    resolveOperation(toolCall) === "run"
      ? findNodeReplComputerOperation({
          display: [toolCall.raw, toolCall.output],
          results: [toolCall.output, readRawOutput(toolCall.raw), toolCall.raw],
        })
      : undefined;
  const persisted = parsePersistedResult(
    removeProjectedImagePlaceholders(
      removeProjectedCompletionMarkers(projectedText),
      images.length > 0,
    ),
  );
  const observationImages = findObservationImages(toolCall.raw);

  return {
    operation: resolveOperation(toolCall),
    // Computer Use 的 cell 由产品标签展示（node-repl.tsx 用 computerOperation 渲染动作词）。
    // cell input 里的 `title` 是模型自己写的推理语言标题——中文短语或英文思考文本，
    // 在英文界面里就是错标；已知 Computer 操作时必须抑制它，未知的 js cell 保持原样。
    userTitle: computerOperation ? undefined : readUserTitle(toolCall, inputs),
    ...(computerOperation ? { computerOperation } : {}),
    code: removeLeadingBlankLines(readInputString(inputs, ["code"])),
    moduleDirectory: readInputString(inputs, ["dir", "path"])?.trim(),
    ...persisted,
    ...(hasBrowserTurnEndDisplay(toolCall.raw)
      ? { displaySource: "browser_turn_end" as const }
      : {}),
    ...(app ? { app } : {}),
    error:
      extractError(toolCall.error) ??
      (toolCall.status === "failed"
        ? outputCandidates.map((candidate) => extractError(candidate)).find(Boolean)
        : undefined),
    images,
    // 修复依据：只隐藏已由 conversation display 在折叠区外展示的图片；旧结果仍可在详情查看。
    ...(hasComputerImageDisplay(toolCall.raw) ? { imagesInConversation: true } : {}),
    ...(observationImages.length > 0 ? { observationImages } : {}),
  };
}
