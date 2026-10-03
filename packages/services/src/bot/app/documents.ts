/**
 * Bot 文档解码：把 adapter 读到的原始 JSON 归一化成可用的 app 层文档。
 *
 * 校验边界：信封结构非法 → BotStoreCorruptError（保留原文件、报错给调用方）；
 * 字段级缺失/枚举过期 → 归一化回退，避免旧版本或局部损坏让整个文档不可用。
 */
import { BotStoreCorruptError } from "./ports.js";
import type { BotConversationDocument, BotIdentityDocument, BotMemoryDocument } from "./ports.js";
import { BOT_STORE_VERSION } from "./ports.js";
import { normalizeBotProfile, type BotIdentity } from "../domain/identity.js";
import { normalizePersonalMemoryRecord } from "../domain/memory.js";
import { alignBotConversationWorkspace, createBotConversationShell } from "../domain/shell.js";
import type { BotWorkspaceRef } from "../domain/shell.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function decodeIdentityDocument(raw: unknown, now: number): BotIdentityDocument {
  const root = asRecord(raw);
  const identityRaw = root ? asRecord(root.identity) : null;
  if (!root || !identityRaw) {
    throw new BotStoreCorruptError("identity", "missing identity object");
  }
  const id = typeof identityRaw.id === "string" ? identityRaw.id.trim() : "";
  if (id.length === 0) {
    throw new BotStoreCorruptError("identity", "missing identity id");
  }

  const createdAt = readTimestamp(identityRaw.createdAt, now);
  const identity: BotIdentity = {
    id,
    createdAt,
    updatedAt: readTimestamp(identityRaw.updatedAt, createdAt),
  };

  return {
    version: readTimestamp(root.version, BOT_STORE_VERSION),
    identity,
    profile: normalizeBotProfile(root.profile, now),
  };
}

export function decodeConversationDocument(
  raw: unknown,
  workspace: BotWorkspaceRef,
  now: number,
): BotConversationDocument {
  const root = asRecord(raw);
  const shellRaw = root ? asRecord(root.shell) : null;
  if (!root || !shellRaw) {
    throw new BotStoreCorruptError("conversation", "missing shell object");
  }
  const sessionIdRaw = shellRaw.sessionId;
  if (sessionIdRaw !== null && sessionIdRaw !== undefined && typeof sessionIdRaw !== "string") {
    throw new BotStoreCorruptError("conversation", "sessionId must be a string or null");
  }

  const base = createBotConversationShell({
    workspace: {
      path:
        typeof shellRaw.workspacePath === "string" && shellRaw.workspacePath.length > 0
          ? shellRaw.workspacePath
          : workspace.path,
      key:
        typeof shellRaw.workspaceKey === "string" && shellRaw.workspaceKey.length > 0
          ? shellRaw.workspaceKey
          : workspace.key,
    },
    now,
  });

  const restored = {
    ...base,
    sessionId:
      typeof sessionIdRaw === "string" && sessionIdRaw.trim().length > 0 ? sessionIdRaw : null,
    createdAt: readTimestamp(shellRaw.createdAt, now),
    updatedAt: readTimestamp(shellRaw.updatedAt, now),
  };

  // workspace 归属以宿主当前配置为准（数据目录迁移 / profile 切换后指针不得失配）。
  return {
    version: readTimestamp(root.version, BOT_STORE_VERSION),
    shell: alignBotConversationWorkspace(restored, workspace, now).shell,
  };
}

export function decodeMemoryDocument(raw: unknown, now: number): BotMemoryDocument {
  const root = asRecord(raw);
  if (!root || !Array.isArray(root.records)) {
    throw new BotStoreCorruptError("memory", "missing records array");
  }

  const records = [];
  for (const entry of root.records) {
    // 单条无法修复的记录（缺 category/title/id）不承载可恢复身份，丢弃即可；
    // 这与“整个文档不可用”不同，后者必须报错并保留文件。
    const normalized = normalizePersonalMemoryRecord(entry, now);
    if (normalized) records.push(normalized);
  }

  return { version: readTimestamp(root.version, BOT_STORE_VERSION), records };
}
