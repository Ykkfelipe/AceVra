import { z } from "zod";

/**
 * Cross-Mode Continuity 契约（cross-mode）：模式 ID、跨模式对象引用与转移矩阵。
 * 参考 roadmap：docs/roadmap/cross-mode-continuity.md。
 *
 * 本模块只描述契约与边界，不执行任何模式切换、会话创建或工作派发；
 * Bot / Coding / Multitask / UI 的接入方消费这里的类型与校验，不得自行复制或放宽。
 */

/** AceVra 顶层模式。字符串本身是稳定模式 ID，序列化后不得改名；新增模式属于契约版本变更。 */
export const ACEVRA_MODES = ["bot", "coding", "multitask"] as const;
export type AceVraMode = (typeof ACEVRA_MODES)[number];

export function isAceVraMode(value: unknown): value is AceVraMode {
  return typeof value === "string" && (ACEVRA_MODES as readonly string[]).includes(value);
}

export const aceVraModeSchema = z.enum(ACEVRA_MODES);

/**
 * 可跨模式引用的持久对象种类（roadmap 对象图：
 * Goal → Project → { Idea, Coding Session, Multitask Run, Decision, Artifact }）。
 * 新增种类是加法变更；既有字面量不得改名或复用。
 */
export const HANDOFF_OBJECT_KINDS = [
  "goal",
  "project",
  "idea",
  "coding-session",
  "multitask-run",
  "decision",
  "artifact",
  "conversation",
] as const;
export type HandoffObjectKind = (typeof HANDOFF_OBJECT_KINDS)[number];

export function isHandoffObjectKind(value: unknown): value is HandoffObjectKind {
  return typeof value === "string" && (HANDOFF_OBJECT_KINDS as readonly string[]).includes(value);
}

export const handoffObjectKindSchema = z.enum(HANDOFF_OBJECT_KINDS);

/** 对象 ID 保持不透明：只约束字符集与长度，不绑定任何存储格式。 */
export const HANDOFF_OBJECT_ID_MAX_LENGTH = 200;
const HANDOFF_OBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const handoffObjectIdSchema = z
  .string()
  .min(1)
  .max(HANDOFF_OBJECT_ID_MAX_LENGTH)
  .regex(HANDOFF_OBJECT_ID_PATTERN);

export const handoffObjectRefSchema = z
  .object({
    kind: handoffObjectKindSchema,
    id: handoffObjectIdSchema,
  })
  .strict();

export type HandoffObjectRef = z.infer<typeof handoffObjectRefSchema>;

/** 展示与日志用：`kind:id`。id 自身允许包含 ":"，解析时只按第一个 ":" 切分。 */
export function handoffObjectRefKey(ref: HandoffObjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseHandoffObjectRef(text: string): HandoffObjectRef | null {
  const separator = text.indexOf(":");
  if (separator <= 0 || separator === text.length - 1) {
    return null;
  }
  const kind = text.slice(0, separator);
  const id = text.slice(separator + 1);
  if (!isHandoffObjectKind(kind)) {
    return null;
  }
  return handoffObjectIdSchema.safeParse(id).success ? { kind, id } : null;
}

export function sameHandoffObjectRef(a: HandoffObjectRef, b: HandoffObjectRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * v1 允许的跨模式转移（source → 允许的 destination，封闭集合）：
 * - transfer（把工作带到新模式）：bot→coding、coding→multitask
 * - return（把结果带回来源或交给 Bot）：multitask→coding、coding→bot、multitask→bot
 *
 * roadmap 的 "Work → Bot" 即 coding→bot / multitask→bot 两条 return 转移。
 * v1 无同模式自转移，也还没有 bot→multitask；扩展需要新版本契约，不得静默放宽。
 */
export const HANDOFF_FLOW_MATRIX: Readonly<Record<AceVraMode, readonly AceVraMode[]>> =
  Object.freeze({
    bot: Object.freeze(["coding"] as AceVraMode[]),
    coding: Object.freeze(["multitask", "bot"] as AceVraMode[]),
    multitask: Object.freeze(["coding", "bot"] as AceVraMode[]),
  });

export type HandoffDirection = "transfer" | "return";

const HANDOFF_TRANSFER_FLOW_KEYS: ReadonlySet<string> = new Set([
  "bot->coding",
  "coding->multitask",
]);

export function isHandoffTransitionAllowed(source: AceVraMode, destination: AceVraMode): boolean {
  return HANDOFF_FLOW_MATRIX[source].includes(destination);
}

export function handoffDirection(
  source: AceVraMode,
  destination: AceVraMode,
): HandoffDirection | null {
  if (!isHandoffTransitionAllowed(source, destination)) {
    return null;
  }
  return HANDOFF_TRANSFER_FLOW_KEYS.has(`${source}->${destination}`) ? "transfer" : "return";
}
