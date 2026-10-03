// ============================================================
// Cross-Mode origin：跨模式交接在「目的会话」上的持久来源（docs/specs/cross-mode-bot-to-coding.md §4）
// ============================================================
// 三件同属一个事实，放在一处避免漂移：
// - createSession.crossModeHandoff：渲染端确认后的冻结快照（M2 HandoffConfirmation 原样传输）；
// - session entry `v4/cross_mode_origin`：CLI 准入成功后写在目的会话上的唯一持久记录；
// - snapshot.crossModeOrigin / createSession ACK：从 entry 投影出的只读展示/回链视图。
// 词汇（模式、对象引用、返回策略、问题码）全部复用冻结契约 ../cross-mode/，不另立元数据；
// 原始 packet 只存在于 confirmation.packetJson，需要时用 deserializeHandoffPacket 重新解析。

import { z } from "zod";
import { HANDOFF_ISSUE_CODES } from "../cross-mode/errors.js";
import { deserializeHandoffPacket, HANDOFF_RETURN_POLICIES } from "../cross-mode/handoff-packet.js";
import { aceVraModeSchema, handoffObjectRefSchema } from "../cross-mode/modes.js";

export const CROSS_MODE_ORIGIN_SESSION_ENTRY_TYPE = "v4/cross_mode_origin" as const;
export const CROSS_MODE_ORIGIN_VERSION = "cross-mode-origin/v1" as const;

/**
 * packetJson 的传输上界：冻结契约限制的是 included 字节（8 KB），但未勾选的条目也随快照保存
 * （最多 32 条 × 6000 字符），所以这里给结构上界而不是预算；真正的预算校验由准入完成。
 */
const PACKET_JSON_MAX_LENGTH = 256_000;

/** M2 `HandoffConfirmation` 的传输形状（handoffId + 规范快照 + 确认时刻 + 已接受的 warning）。 */
export const crossModeHandoffConfirmationSchema = z
  .object({
    handoffId: z.string().min(1).max(64),
    packetJson: z.string().min(2).max(PACKET_JSON_MAX_LENGTH),
    confirmedAt: z.number().int().nonnegative(),
    warnings: z
      .array(
        z
          .object({
            code: z.enum(HANDOFF_ISSUE_CODES),
            path: z.string().max(200),
            message: z.string().max(500),
            severity: z.enum(["error", "warning"]),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type CrossModeHandoffConfirmation = z.infer<typeof crossModeHandoffConfirmationSchema>;

/** createSession 的可选交接载荷：只接受已确认快照，不接受可编辑草稿。 */
export const crossModeHandoffCreateSchema = z
  .object({ confirmation: crossModeHandoffConfirmationSchema })
  .strict();
export type CrossModeHandoffCreate = z.infer<typeof crossModeHandoffCreateSchema>;

/** 目的侧工作落点：workspacePath 用于文件/展示，workspaceIdentity 用于身份隔离（远程）。 */
export const crossModeOriginDestinationSchema = z
  .object({
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1).optional(),
  })
  .strict();

/** session entry `v4/cross_mode_origin` 的 data：原样保存确认快照 + 准入结果。 */
export const crossModeOriginEntrySchema = z
  .object({
    version: z.literal(CROSS_MODE_ORIGIN_VERSION),
    confirmation: crossModeHandoffConfirmationSchema,
    /** 目的侧工作的稳定引用（与准入记录的 externalRef 同值）。 */
    resultRef: handoffObjectRefSchema,
    destination: crossModeOriginDestinationSchema,
    acceptedAt: z.number().int().nonnegative(),
  })
  .strict();
export type CrossModeOriginEntry = z.infer<typeof crossModeOriginEntrySchema>;

/**
 * snapshot / ACK 上的只读投影。刻意不含携带的上下文正文：正文已是首条用户消息，
 * 再随每个快照分发既冗余又扩大了个人内容的传播面。
 */
export const crossModeOriginStateSchema = z
  .object({
    version: z.literal(CROSS_MODE_ORIGIN_VERSION),
    handoffId: z.string().min(1).max(64),
    sourceMode: aceVraModeSchema,
    destinationMode: aceVraModeSchema,
    objective: z.string().min(1).max(500),
    sourceRefs: z.array(handoffObjectRefSchema).max(16),
    returnPolicy: z.enum(HANDOFF_RETURN_POLICIES),
    resultRef: handoffObjectRefSchema,
    acceptedAt: z.number().int().nonnegative(),
  })
  .strict();
export type CrossModeOriginState = z.infer<typeof crossModeOriginStateSchema>;

/** 宽容读取持久 entry：形状不符返回 null（坏数据不能把整个会话快照拖垮）。 */
export function parseCrossModeOriginEntry(data: unknown): CrossModeOriginEntry | null {
  const parsed = crossModeOriginEntrySchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * entry → 展示投影。快照只能经冻结契约重新解析（版本未知/篡改时契约抛 HandoffContractError），
 * 这里把失败收敛为 null，由调用方按「没有来源」处理。
 */
export function projectCrossModeOriginState(
  entry: CrossModeOriginEntry,
): CrossModeOriginState | null {
  try {
    const packet = deserializeHandoffPacket(entry.confirmation.packetJson);
    if (packet.handoffId !== entry.confirmation.handoffId) return null;
    return {
      version: CROSS_MODE_ORIGIN_VERSION,
      handoffId: packet.handoffId,
      sourceMode: packet.sourceMode,
      destinationMode: packet.destinationMode,
      objective: packet.objective,
      sourceRefs: packet.sourceRefs,
      returnPolicy: packet.returnPolicy,
      resultRef: entry.resultRef,
      acceptedAt: entry.acceptedAt,
    };
  } catch {
    return null;
  }
}
