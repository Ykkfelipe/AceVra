// ============================================================
// startMultitaskHandoff：Coding → Multitask 的跨模式交接入口
// ============================================================
// 从 command.ts 拆出（max-lines 门）：载荷、accepted 结果与拒绝词表三件同属一个命令，
// bootstrap 铸 fault code、客户端反查文案，两侧共享这一份词表避免漂移。
// 词汇（sensitivity / permissions / returnPolicy / object ref）直接复用冻结契约
// （../cross-mode/，同一包内唯一来源，不复制词表）。

import { z } from "zod";
import { HANDOFF_CONTEXT_SENSITIVITIES } from "../cross-mode/context.js";
import { HANDOFF_PERMISSIONS, HANDOFF_RETURN_POLICIES } from "../cross-mode/handoff-packet.js";
import { handoffObjectRefSchema } from "../cross-mode/modes.js";

/**
 * 命令载荷。非输入类命令（不排队、不带 baseRevision），登记在 cross-mode-handoff 组。
 * 载荷只做传输层宽松校验：冻结契约（objective / 上下文档位与上限、权限对等、项目关联）
 * 仍是唯一来源，由 CLI 侧 handoff 服务归一化时执行；plan 的结构真值由 Multitask 提交面
 * schema 在提交边界复验。
 */
export const startMultitaskHandoffCommandSchema = z.object({
  objective: z.string().trim().min(1).max(2000),
  context: z
    .array(
      z
        .object({
          label: z.string().trim().min(1).max(200),
          content: z.string().min(1).max(6000),
          sensitivity: z.enum(HANDOFF_CONTEXT_SENSITIVITIES).optional(),
          provenance: z.array(handoffObjectRefSchema).max(8).optional(),
        })
        .strict(),
    )
    .max(32)
    .optional(),
  constraints: z.array(z.string().trim().min(1).max(300)).max(12).optional(),
  permissions: z.array(z.enum(HANDOFF_PERMISSIONS)).max(8).optional(),
  returnPolicy: z.enum(HANDOFF_RETURN_POLICIES).optional(),
  linkedProject: handoffObjectRefSchema.nullable().optional(),
  plan: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      workers: z
        .array(
          z
            .object({
              id: z.string().min(1).max(64),
              role: z.string().trim().min(1).max(120),
              profile: z.string().trim().min(1).max(120).optional(),
              model: z.string().trim().min(1).max(200).optional(),
              access: z.enum(["read", "write"]),
            })
            .strict(),
        )
        .min(1)
        .max(4),
      tasks: z
        .array(
          z
            .object({
              id: z.string().min(1).max(64),
              worker: z.string().min(1).max(64),
              prompt: z.string().trim().min(1).max(16000),
              dependsOn: z.array(z.string().min(1).max(64)).max(16).default([]),
            })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
});
export type StartMultitaskHandoffCommandPayload = z.infer<
  typeof startMultitaskHandoffCommandSchema
>;

/**
 * accepted ACK 结果。status accepted = Multitask run 已登记（externalRef = 回链）；
 * rejected = 用户拒绝运行确认 / 目标不可用 / 权限不足等，记录保持可重试语义，reason 可展示。
 */
export const startMultitaskHandoffResultSchema = z.object({
  type: z.literal("startMultitaskHandoff"),
  handoffId: z.string().min(1),
  status: z.enum(["accepted", "rejected"]),
  externalRef: z.object({ kind: z.string().min(1), id: z.string().min(1) }).nullable(),
  reason: z.string().nullable(),
});

// startMultitaskHandoff 的拒绝：前缀 + reason。invalid_input = 冻结契约校验未过（packet / context /
// plan 归一化失败）；session_busy = 会话有活动 turn；start_failed = 启动期未预期错误。
export const MULTITASK_HANDOFF_START_REJECTED_FAULT_PREFIX =
  "fault.command.multitaskHandoffStartRejected." as const;
export const multitaskHandoffStartRejectionReasonSchema = z.enum([
  "invalid_input",
  "session_busy",
  "start_failed",
]);
export type MultitaskHandoffStartRejectionReason = z.infer<
  typeof multitaskHandoffStartRejectionReasonSchema
>;
