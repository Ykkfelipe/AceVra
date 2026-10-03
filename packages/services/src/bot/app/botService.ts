/**
 * IBotService 实现：Bot 身份/档案、对话指针、个人记忆的唯一写入方。
 * 不做 IO；持久化经由 BotStorePort 注入。
 *
 * 并发：同一实例内所有读-改-写串行化（串行队列）。Bot 文档是单机个人数据，
 * 不需要跨进程一致性；这里只保证同进程内不会互相覆盖。
 */
import { randomUUID } from "node:crypto";
import type { BotIdentityView, BotMemoryContextRequest, IBotService } from "../contract.js";
import type { BotProfilePatch } from "../domain/identity.js";
import {
  applyBotProfilePatch,
  createDefaultBotIdentity,
  createDefaultBotProfile,
} from "../domain/identity.js";
import type { BotCapabilityDomain } from "../domain/capabilities.js";
import { buildBotCapabilitySurface } from "../domain/capabilities.js";
import type { PersonalMemoryContext, PersonalMemoryInput } from "../domain/memory.js";
import {
  DEFAULT_MAX_MEMORY_RECORDS,
  MAX_MEMORY_CONTEXT_BYTES,
  normalizePersonalMemoryRecord,
  renderPersonalMemoryContext,
  selectRelevantPersonalMemory,
} from "../domain/memory.js";
import { createBotConversationShell, withBotConversationSession } from "../domain/shell.js";
import type { BotWorkspaceRef } from "../domain/shell.js";
import {
  decodeConversationDocument,
  decodeIdentityDocument,
  decodeMemoryDocument,
} from "./documents.js";
import { BOT_STORE_VERSION, type BotStorePort } from "./ports.js";

interface BotServiceDependencies {
  store: BotStorePort;
  /** 专用 Bot workspace；由宿主按数据根目录解析后注入。 */
  workspace: BotWorkspaceRef;
  /**
   * 宿主当前真的能交给 Bot 执行的能力域。
   * M1 事实来源：AceVra 原生已有 web/files;email/calendar/devices 尚无实现，
   * 不得因为“路线图里有”就标记为 available。
   */
  executableDomains?: readonly BotCapabilityDomain[];
  now?: () => number;
  createId?: () => string;
}

const M1_EXECUTABLE_DOMAINS: readonly BotCapabilityDomain[] = ["web", "files"];

export function createBotService(deps: BotServiceDependencies): IBotService {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? (() => randomUUID());
  const workspace = deps.workspace;
  const executableDomains = deps.executableDomains ?? M1_EXECUTABLE_DOMAINS;

  // 串行队列：任一任务失败不阻塞后续任务（settled 后再排下一个）。
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function loadIdentityDocument() {
    const raw = await deps.store.readIdentity();
    if (raw === null) return null;
    return decodeIdentityDocument(raw, now());
  }

  async function loadOrCreateIdentityDocument() {
    const existing = await loadIdentityDocument();
    if (existing) return existing;

    const timestamp = now();
    const document = {
      version: BOT_STORE_VERSION,
      identity: createDefaultBotIdentity(timestamp, `bot_${createId()}`),
      profile: createDefaultBotProfile(timestamp),
    };
    await deps.store.writeIdentity(document);
    return document;
  }

  async function loadMemoryDocument() {
    const raw = await deps.store.readMemory();
    if (raw === null) return { version: BOT_STORE_VERSION, records: [] };
    return decodeMemoryDocument(raw, now());
  }

  function toView(document: {
    identity: BotIdentityView["identity"];
    profile: BotIdentityView["profile"];
  }): BotIdentityView {
    return { identity: document.identity, profile: document.profile };
  }

  return {
    getIdentity() {
      return serialize(async () => toView(await loadOrCreateIdentityDocument()));
    },

    updateProfile(patch: BotProfilePatch) {
      return serialize(async () => {
        const document = await loadOrCreateIdentityDocument();
        const timestamp = now();
        const updated = {
          version: document.version,
          identity: { ...document.identity, updatedAt: timestamp },
          profile: applyBotProfilePatch(document.profile, patch, timestamp),
        };
        await deps.store.writeIdentity(updated);
        return toView(updated);
      });
    },

    getConversationShell() {
      return serialize(async () => {
        const raw = await deps.store.readConversation();
        if (raw === null) {
          const shell = createBotConversationShell({
            workspace,
            now: now(),
          });
          await deps.store.writeConversation({
            version: BOT_STORE_VERSION,
            shell,
          });
          return shell;
        }
        const document = decodeConversationDocument(raw, workspace, now());
        // 读取不改盘：workspace 校正只在内存中生效，下一次真实写入时落地。
        return document.shell;
      });
    },

    setConversationSession(sessionId: string | null) {
      return serialize(async () => {
        const raw = await deps.store.readConversation();
        const timestamp = now();
        const base =
          raw === null
            ? createBotConversationShell({ workspace, now: timestamp })
            : decodeConversationDocument(raw, workspace, timestamp).shell;

        const result = withBotConversationSession(base, sessionId, timestamp);
        if (!result.changed) return result.shell;
        await deps.store.writeConversation({
          version: BOT_STORE_VERSION,
          shell: result.shell,
        });
        return result.shell;
      });
    },

    listMemory() {
      return serialize(async () => (await loadMemoryDocument()).records);
    },

    rememberMemory(input: PersonalMemoryInput) {
      return serialize(async () => {
        const document = await loadMemoryDocument();
        const timestamp = now();
        const record = normalizePersonalMemoryRecord(
          {
            ...input,
            id: input.id ?? `mem_${createId()}`,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          timestamp,
        );
        if (!record) {
          throw new Error("personal memory requires a category and a title");
        }

        const existing = document.records.find((entry) => entry.id === record.id);
        // upsert 保留首次创建时间；同 id 覆盖只更新内容与 updatedAt。
        const stored = existing ? { ...record, createdAt: existing.createdAt } : record;
        const records = existing
          ? document.records.map((entry) => (entry.id === stored.id ? stored : entry))
          : [...document.records, stored];
        await deps.store.writeMemory({ version: document.version, records });
        return stored;
      });
    },

    forgetMemory(memoryId: string) {
      return serialize(async () => {
        const document = await loadMemoryDocument();
        const records = document.records.filter((entry) => entry.id !== memoryId);
        if (records.length === document.records.length) return false;
        await deps.store.writeMemory({ version: document.version, records });
        return true;
      });
    },

    buildMemoryContext(request: BotMemoryContextRequest): Promise<PersonalMemoryContext> {
      return serialize(async () => {
        const document = await loadMemoryDocument();
        const selection = selectRelevantPersonalMemory(document.records, request.query, {
          maxRecords: request.maxRecords ?? DEFAULT_MAX_MEMORY_RECORDS,
        });
        return renderPersonalMemoryContext(selection, {
          maxBytes: request.maxBytes ?? MAX_MEMORY_CONTEXT_BYTES,
        });
      });
    },

    listCapabilitySurface() {
      return Promise.resolve(buildBotCapabilitySurface({ executableDomains, now: now() }));
    },
  };
}
