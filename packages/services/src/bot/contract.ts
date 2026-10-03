/**
 * bot 模块公开契约：Personal Bot 的身份、档案、个人记忆与能力面。
 *
 * 只允许从这里 import。持久化细节（JSON 文档、原子写、数据根目录）在模块内部。
 * 服务面只承载 Bot 自有事实；会话消息、模型、权限仍归各自的既有 owner。
 */
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { BotIdentity, BotProfile, BotProfilePatch } from "./domain/identity.js";
import type {
  PersonalMemoryCategory,
  PersonalMemoryContext,
  PersonalMemoryInput,
  PersonalMemoryRecord,
} from "./domain/memory.js";
import type { BotCapabilitySurface } from "./domain/capabilities.js";
import type { BotConversationShell } from "./domain/shell.js";

export type {
  BotAccent,
  BotAvatar,
  BotIdentity,
  BotProfile,
  BotProfilePatch,
  BotStyle,
  BotTone,
  BotVerbosity,
} from "./domain/identity.js";
export type {
  PersonalMemoryCategory,
  PersonalMemoryContext,
  PersonalMemoryInput,
  PersonalMemoryRecord,
  PersonalMemorySelection,
  PersonalMemorySource,
} from "./domain/memory.js";
export type {
  BotCapabilityAccess,
  BotCapabilityAvailability,
  BotCapabilityDomain,
  BotCapabilityEntry,
  BotCapabilitySurface,
} from "./domain/capabilities.js";
export type { BotConversationShell, BotWorkspaceRef } from "./domain/shell.js";

export {
  DEFAULT_BOT_DESCRIPTOR,
  DEFAULT_BOT_DISPLAY_NAME,
  DEFAULT_BOT_STYLE,
  MAX_BOT_DESCRIPTOR_LENGTH,
  MAX_BOT_DISPLAY_NAME_LENGTH,
} from "./domain/identity.js";

export {
  DEFAULT_MAX_MEMORY_RECORDS,
  MAX_MEMORY_CONTEXT_BYTES,
  MAX_MEMORY_SUMMARY_LENGTH,
  MAX_MEMORY_TAGS,
  MAX_MEMORY_TITLE_LENGTH,
  PERSONAL_MEMORY_CATEGORIES,
} from "./domain/memory.js";

export { BOT_CAPABILITY_DOMAINS } from "./domain/capabilities.js";

export { BotStoreCorruptError, isBotStoreCorruptError } from "./app/ports.js";

/** 身份 + 档案的读取结果；两者同属 identity 文档，与对话状态无关。 */
export interface BotIdentityView {
  identity: BotIdentity;
  profile: BotProfile;
}

export interface BotMemoryContextRequest {
  /** 当前请求文本；空查询只返回置顶记忆。 */
  query: string;
  maxRecords?: number;
  maxBytes?: number;
}

export interface BotMemoryListEntry {
  record: PersonalMemoryRecord;
  category: PersonalMemoryCategory;
}

/**
 * Personal Bot 服务面。
 *
 * 状态所有者：本服务是 Bot 身份/档案、对话指针、个人记忆的唯一写入方；
 * 调用方只能通过这里的命令改状态，不得直接读写 Bot 数据文档。
 */
export interface IBotService {
  /** 读取 Bot 身份与档案；首次调用以默认值创建并持久化。 */
  getIdentity(): Promise<BotIdentityView>;

  /** 局部更新档案；未给出的字段保持不变，不会触碰记忆或对话指针。 */
  updateProfile(patch: BotProfilePatch): Promise<BotIdentityView>;

  /** 读取持久化对话外壳（workspace 归属 + 对话指针）。 */
  getConversationShell(): Promise<BotConversationShell>;

  /** 设置/清除 Bot 对话指针；相同值重复设置幂等。 */
  setConversationSession(sessionId: string | null): Promise<BotConversationShell>;

  /** 列出全部个人记忆（UI 展示用；检索请用 buildMemoryContext）。 */
  listMemory(): Promise<PersonalMemoryRecord[]>;

  /** 新增或按 id 覆盖一条个人记忆。 */
  rememberMemory(input: PersonalMemoryInput): Promise<PersonalMemoryRecord>;

  /** 删除一条个人记忆；返回是否真的删除。 */
  forgetMemory(memoryId: string): Promise<boolean>;

  /** 有界相关性检索：最多 maxRecords 条 / maxBytes 字节，始终报告省略条数。 */
  buildMemoryContext(request: BotMemoryContextRequest): Promise<PersonalMemoryContext>;

  /** Bot 能力面声明（web/email/calendar/files/devices 的可用性与审批语义）。 */
  listCapabilitySurface(): Promise<BotCapabilitySurface>;
}

export const IBotService = createServiceDescriptor<IBotService>(ServiceChannels.Bot);
