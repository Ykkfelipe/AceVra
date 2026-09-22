// Codex App Server wire 面（domain，纯函数）。
//
// 方法/事件名来自对已安装 Codex 二进制协议串的枚举（codex-cli 0.155.0-alpha.9.2），
// payload 形状按防御式解析建模：缺字段/未知变体一律返回 null 由上层丢弃，绝不抛错，
// 在首次授权 E2E 之前不假设任何字段必填。精确形状以 spec 的 E2E checklist 为准。
import type { CodexExecutionApprovalRequestInfo } from "@zcode/shared";

/** 本后端向 `codex app-server` 发起的客户端请求方法名。 */
export const CODEX_METHODS = {
  initialize: "initialize",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadItemsList: "thread/items/list",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  accountRead: "account/read",
} as const;

/** Codex 项类型（ThreadItem 变体的已知子集）。 */
type CodexItemKind =
  | "agentMessage"
  | "reasoning"
  | "commandExecution"
  | "fileChange"
  | "mcpToolCall"
  | "webSearch"
  | "userMessage";

interface CodexItemBase {
  readonly kind: CodexItemKind;
  readonly itemId: string | null;
  /** 命令/文件/MCP 项的 Codex 侧状态串（agentMessage/reasoning 恒为 null）。 */
  readonly status?: string | null;
}

export interface CodexAgentMessageItem extends CodexItemBase {
  readonly kind: "agentMessage";
  readonly text: string;
}

export interface CodexReasoningItem extends CodexItemBase {
  readonly kind: "reasoning";
  readonly text: string;
}

export interface CodexCommandExecutionItem extends CodexItemBase {
  readonly kind: "commandExecution";
  readonly command: string;
  readonly aggregatedOutput: string | null;
  readonly exitCode: number | null;
  readonly status: string | null;
}

export interface CodexFileChangeItem extends CodexItemBase {
  readonly kind: "fileChange";
  readonly changes: ReadonlyArray<{ path: string; kind: string }>;
  readonly status: string | null;
}

export interface CodexMcpToolCallItem extends CodexItemBase {
  readonly kind: "mcpToolCall";
  readonly server: string;
  readonly tool: string;
  readonly status: string | null;
}

export interface CodexWebSearchItem extends CodexItemBase {
  readonly kind: "webSearch";
  readonly query: string;
}

export type CodexItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem;

/** 服务器主动下发的通知（无请求 id 语义）。 */
export type CodexServerNotification =
  | { readonly type: "threadStarted"; readonly threadId: string }
  | { readonly type: "turnStarted"; readonly threadId: string | null; readonly turnId: string | null }
  | {
      readonly type: "turnCompleted";
      readonly threadId: string | null;
      readonly turnId: string | null;
      readonly outcome: "success" | "interrupted" | "failed";
      readonly errorMessage: string | null;
    }
  | {
      readonly type: "itemStarted";
      readonly threadId: string | null;
      readonly turnId: string | null;
      readonly item: CodexItem;
    }
  | {
      readonly type: "itemCompleted";
      readonly threadId: string | null;
      readonly turnId: string | null;
      readonly item: CodexItem;
    }
  | {
      readonly type: "itemDelta";
      readonly deltaKind: "agentMessage" | "reasoning" | "commandOutput" | "fileChangeOutput";
      readonly threadId: string | null;
      readonly itemId: string | null;
      readonly append: string;
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "unknown"; readonly method: string };

/** 服务器 → 客户端的请求（需要应答；rawId 是 JSON-RPC request id）。 */
type CodexServerRequest =
  | {
      readonly type: "approval";
      readonly rawId: number;
      readonly info: CodexExecutionApprovalRequestInfo;
      /** item/permissions/requestApproval 请求的权限 profile（仅宿主内存，不下发通道）。 */
      readonly requestedPermissions?: unknown;
    }
  | { readonly type: "unhandled"; readonly rawId: number; readonly method: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseItem(value: unknown): CodexItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const kind = asString(record.type) ?? asString(record.itemType);
  const itemId = asString(record.id) ?? asString(record.itemId);
  switch (kind) {
    case "agentMessage":
      return {
        kind,
        itemId,
        text: asString(record.text) ?? "",
      };
    case "reasoning":
      return {
        kind,
        itemId,
        text: asString(record.text) ?? asString(record.summary) ?? "",
      };
    case "commandExecution":
      return {
        kind,
        itemId,
        command: asString(record.command) ?? "",
        aggregatedOutput: asOptionalString(record.aggregatedOutput),
        exitCode: asNumber(record.exitCode),
        status: asOptionalString(record.status),
      };
    case "fileChange": {
      const rawChanges = Array.isArray(record.changes) ? record.changes : [];
      return {
        kind,
        itemId,
        changes: rawChanges.flatMap((entry) => {
          const change = asRecord(entry);
          if (!change) return [];
          const path = asString(change.path) ?? asString(change.file);
          if (!path) return [];
          return [{ path, kind: asString(change.kind) ?? "update" }];
        }),
        status: asOptionalString(record.status),
      };
    }
    case "mcpToolCall":
      return {
        kind,
        itemId,
        server: asString(record.server) ?? "",
        tool: asString(record.tool) ?? "",
        status: asOptionalString(record.status),
      };
    case "webSearch":
      return {
        kind,
        itemId,
        query: asString(record.query) ?? asString(record.queryText) ?? "",
      };
    default:
      return null;
  }
}

function parseOutcome(status: unknown, hasError: boolean): "success" | "interrupted" | "failed" {
  const value = asString(status) ?? "";
  if (/(interrupt|abort|cancel|decline)/i.test(value)) return "interrupted";
  if (/(fail|error)/i.test(value) || (hasError && !value)) return "failed";
  return "success";
}

/** 容错解析服务器通知；未知方法原样携带由上层计数丢弃。 */
export function parseCodexNotification(method: string, params: unknown): CodexServerNotification {
  const record = asRecord(params) ?? {};
  const threadId = asOptionalString(record.threadId) ?? asOptionalString(record.thread_id);
  const turnId = asOptionalString(record.turnId) ?? asOptionalString(record.turn_id);
  switch (method) {
    case "thread/started": {
      // E2E 观察：id 嵌套在 params.thread.id，而非顶层 threadId。
      const thread = typeof record.thread === "object" && record.thread !== null ? (record.thread as Record<string, unknown>) : null;
      const id =
        asOptionalString(record.threadId) ??
        asOptionalString(record.thread_id) ??
        asOptionalString(thread?.id);
      return id ? { type: "threadStarted", threadId: id } : { type: "unknown", method };
    }
    case "turn/started":
      return { type: "turnStarted", threadId, turnId };
    case "turn/completed":
      return {
        type: "turnCompleted",
        threadId,
        turnId,
        outcome: parseOutcome(record.status ?? record.outcome, Boolean(record.error)),
        errorMessage: asOptionalString(
          asRecord(record.error)?.message ?? record.error ?? record.lastErrorMessage,
        ),
      };
    case "item/started":
    case "item/completed": {
      const item = parseItem(record.item ?? record);
      if (!item) return { type: "unknown", method };
      return { type: method === "item/started" ? "itemStarted" : "itemCompleted", threadId, turnId, item };
    }
    case "item/agentMessage/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const deltaKind =
        method === "item/agentMessage/delta"
          ? "agentMessage"
          : method.startsWith("item/reasoning/")
            ? "reasoning"
            : method === "item/commandExecution/outputDelta"
              ? "commandOutput"
              : "fileChangeOutput";
      return {
        type: "itemDelta",
        deltaKind,
        threadId,
        itemId: asOptionalString(record.itemId) ?? asOptionalString(record.item_id),
        append: asString(record.delta) ?? asString(record.text) ?? "",
      };
    }
    case "error":
      return {
        type: "error",
        message: asString(record.message) ?? asString(record.error) ?? "codex error",
      };
    default:
      return { type: "unknown", method };
  }
}

/** 容错解析服务器请求；审批类请求必须拿到原始 request id 才能应答。 */
export function parseCodexServerRequest(
  method: string,
  params: unknown,
  rawId: number,
): CodexServerRequest {
  const record = asRecord(params) ?? {};
  const approvalMethods: ReadonlyArray<{ method: string; kind: CodexExecutionApprovalRequestInfo["kind"] }> = [
    { method: "item/commandExecution/requestApproval", kind: "commandExecution" },
    { method: "item/fileChange/requestApproval", kind: "fileChange" },
    { method: "item/permissions/requestApproval", kind: "permissions" },
  ];
  const matched = approvalMethods.find((entry) => entry.method === method);
  if (!matched) return { type: "unhandled", rawId, method };
  const item = parseItem(record.item ?? record);
  const command = asString(record.command) ?? (item?.kind === "commandExecution" ? item.command : null);
  const toolName =
    matched.kind === "commandExecution"
      ? "codex.commandExecution"
      : matched.kind === "fileChange"
        ? "codex.fileChange"
        : `codex.${asOptionalString(record.server) ?? "mcpToolCall"}`;
  const summary =
    command ??
    (item?.kind === "fileChange"
      ? item.changes.map((change) => `${change.kind}:${change.path}`).join(", ")
      : asString(record.reason) ??
        asString(record.summary) ??
        asString(record.title) ??
        method);
  return {
    type: "approval",
    rawId,
    // 权限请求的 profile 原样留存供批准时回传；其余请求不携带该字段。
    ...(matched.kind === "permissions" && typeof record.permissions === "object" && record.permissions !== null
      ? { requestedPermissions: record.permissions }
      : {}),
    info: {
      interactionId: "",
      kind: matched.kind,
      toolName,
      summary,
    },
  };
}

/**
 * 错误信息脱敏：截断并剥掉绝对路径与超长串。Codex 的错误消息可能携带本机路径，
 * 不允许原样进入 ACK / lastError。
 */
export function scrubCodexErrorDetail(message: string, maxChars = 200): string {
  const withoutPaths = message.replace(/(\/|\\)[^\s"']+(\/|\\)[^\s"']*/g, "<path>");
  return withoutPaths.length > maxChars
    ? `${withoutPaths.slice(0, maxChars)}…`
    : withoutPaths;
}
