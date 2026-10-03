/**
 * app 层端口：botService 只依赖这些接口，IO 由 adapters 实现并在宿主注入。
 *
 * 端口按文档拆分（identity / conversation / memory），与 M1 spec §4 的
 * “身份与对话状态分离”一致：任一文档损坏都不影响另外两文档的读写。
 */
import type { BotIdentity, BotProfile } from "../domain/identity.js";
import type { BotConversationShell } from "../domain/shell.js";
import type { PersonalMemoryRecord } from "../domain/memory.js";

export const BOT_STORE_VERSION = 1;

export interface BotIdentityDocument {
  version: number;
  identity: BotIdentity;
  profile: BotProfile;
}

export interface BotConversationDocument {
  version: number;
  shell: BotConversationShell;
}

export interface BotMemoryDocument {
  version: number;
  records: PersonalMemoryRecord[];
}

/**
 * 文档读取语义：文件不存在返回 null；文件存在但内容不可用抛 BotStoreCorruptError。
 * 实现方不得在读取失败时删除或覆盖用户数据。
 */
export interface BotStorePort {
  readIdentity(): Promise<unknown | null>;
  writeIdentity(document: BotIdentityDocument): Promise<void>;
  readConversation(): Promise<unknown | null>;
  writeConversation(document: BotConversationDocument): Promise<void>;
  readMemory(): Promise<unknown | null>;
  writeMemory(document: BotMemoryDocument): Promise<void>;
}

/**
 * 已存在但无法使用的 Bot 文档（JSON 解析失败或结构非法）。
 * 与“文件不存在”区分：前者必须报错并保留原文件，后者按默认值创建。
 */
export class BotStoreCorruptError extends Error {
  readonly document: string;

  constructor(document: string, reason: string) {
    super(`bot store document is unusable: ${document} (${reason})`);
    this.name = "BotStoreCorruptError";
    this.document = document;
  }
}

export function isBotStoreCorruptError(error: unknown): error is BotStoreCorruptError {
  return error instanceof BotStoreCorruptError;
}
