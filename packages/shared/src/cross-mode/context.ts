import { z } from "zod";
import { createUuid } from "../uuid.js";
import { HandoffContractError, type HandoffValidationIssue } from "./errors.js";
import { handoffObjectRefKey, handoffObjectRefSchema, type HandoffObjectRef } from "./modes.js";

/**
 * 跨模式转移的「被选中上下文」：逐项可选、可编辑、带来源的最小上下文单元。
 * 隐私语义：personal/sensitive 默认排除，只有用户显式勾选（inclusion === "user"）才允许携带。
 */

export const HANDOFF_CONTEXT_SENSITIVITIES = ["standard", "personal", "sensitive"] as const;
export type HandoffContextSensitivity = (typeof HANDOFF_CONTEXT_SENSITIVITIES)[number];

/** 当前 included/excluded 值的决策来源："auto" 由默认策略给出，"user" 由用户显式决定。 */
export const HANDOFF_CONTEXT_INCLUSIONS = ["auto", "user"] as const;
export type HandoffContextInclusion = (typeof HANDOFF_CONTEXT_INCLUSIONS)[number];

/**
 * 「最少充分上下文」硬上限（v1，刻意保守）。
 * 字节数一律按 UTF-8 计算且只统计 included 项；label/provenance 不占字节预算。
 * 跨模式转移永远不是整段对话或全部记忆的搬运；超限必须报错，不允许截断。
 */
export const HANDOFF_CONTEXT_LIMITS = Object.freeze({
  maxItems: 32,
  maxIncludedItems: 16,
  maxItemBytes: 2048,
  maxIncludedTotalBytes: 8192,
  maxProvenanceRefsPerItem: 8,
  maxLabelChars: 120,
  maxContentChars: 6000,
});

export function handoffContextItemByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export const handoffContextItemSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(HANDOFF_CONTEXT_LIMITS.maxLabelChars),
    content: z.string().min(1).max(HANDOFF_CONTEXT_LIMITS.maxContentChars),
    sensitivity: z.enum(HANDOFF_CONTEXT_SENSITIVITIES),
    included: z.boolean(),
    inclusion: z.enum(HANDOFF_CONTEXT_INCLUSIONS),
    provenance: z
      .array(handoffObjectRefSchema)
      .max(HANDOFF_CONTEXT_LIMITS.maxProvenanceRefsPerItem),
  })
  .strict();

export type HandoffContextItem = z.infer<typeof handoffContextItemSchema>;

/** 默认选择策略：standard 默认携带；personal/sensitive 默认排除，等待用户显式勾选。 */
export function resolveDefaultContextSelection(sensitivity: HandoffContextSensitivity): {
  included: boolean;
  inclusion: "auto";
} {
  return { included: sensitivity === "standard", inclusion: "auto" };
}

export interface NewHandoffContextItemInput {
  label: string;
  content: string;
  sensitivity?: HandoffContextSensitivity;
  provenance?: HandoffObjectRef[];
  included?: boolean;
  id?: string;
}

export function createHandoffContextItem(input: NewHandoffContextItemInput): HandoffContextItem {
  const sensitivity = input.sensitivity ?? "standard";
  const selection =
    input.included === undefined
      ? resolveDefaultContextSelection(sensitivity)
      : { included: input.included, inclusion: "user" as const };
  const candidate = {
    id: input.id ?? createUuid(),
    label: input.label,
    content: input.content,
    sensitivity,
    included: selection.included,
    inclusion: selection.inclusion,
    provenance: input.provenance ?? [],
  };
  const parsed = handoffContextItemSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new HandoffContractError(
      "handoff_context_item_invalid",
      `invalid handoff context item: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}

/** included 项的 UTF-8 字节小计。 */
export function sumIncludedHandoffContextBytes(items: readonly HandoffContextItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.included) {
      total += handoffContextItemByteLength(item.content);
    }
  }
  return total;
}

/** 上下文限额检查；preview 与 transfer validation 共用同一份判定，保证口径一致。 */
export function collectHandoffContextLimitViolations(
  items: readonly HandoffContextItem[],
): HandoffValidationIssue[] {
  const issues: HandoffValidationIssue[] = [];
  if (items.length > HANDOFF_CONTEXT_LIMITS.maxItems) {
    issues.push({
      code: "handoff_context_items_limit",
      path: "context",
      message: `context carries ${items.length} items, exceeding the limit of ${HANDOFF_CONTEXT_LIMITS.maxItems}`,
      severity: "error",
    });
  }
  let includedCount = 0;
  items.forEach((item, index) => {
    if (!item.included) {
      return;
    }
    includedCount += 1;
    const bytes = handoffContextItemByteLength(item.content);
    if (bytes > HANDOFF_CONTEXT_LIMITS.maxItemBytes) {
      issues.push({
        code: "handoff_context_item_too_large",
        path: `context[${index}].content`,
        message: `included context item is ${bytes} bytes, exceeding the limit of ${HANDOFF_CONTEXT_LIMITS.maxItemBytes}`,
        severity: "error",
      });
    }
  });
  if (includedCount > HANDOFF_CONTEXT_LIMITS.maxIncludedItems) {
    issues.push({
      code: "handoff_context_included_limit",
      path: "context",
      message: `context includes ${includedCount} items, exceeding the limit of ${HANDOFF_CONTEXT_LIMITS.maxIncludedItems}`,
      severity: "error",
    });
  }
  const includedBytes = sumIncludedHandoffContextBytes(items);
  if (includedBytes > HANDOFF_CONTEXT_LIMITS.maxIncludedTotalBytes) {
    issues.push({
      code: "handoff_context_total_bytes_exceeded",
      path: "context",
      message: `included context is ${includedBytes} bytes, exceeding the budget of ${HANDOFF_CONTEXT_LIMITS.maxIncludedTotalBytes}`,
      severity: "error",
    });
  }
  return issues;
}

export interface HandoffContextPreviewItem {
  readonly itemId: string;
  readonly label: string;
  readonly content: string;
  readonly sensitivity: HandoffContextSensitivity;
  readonly included: boolean;
  readonly inclusion: HandoffContextInclusion;
  readonly provenance: string[];
  readonly bytes: number;
}

export interface HandoffContextPreview {
  readonly items: HandoffContextPreviewItem[];
  readonly includedCount: number;
  readonly excludedCount: number;
  readonly includedBytes: number;
  readonly limits: typeof HANDOFF_CONTEXT_LIMITS;
  readonly withinLimits: boolean;
  readonly violations: HandoffValidationIssue[];
}

/**
 * 用户可见的上下文预览数据面（roadmap「Move to Coding Session」对话框）：
 * 逐项列出将携带/不携带的内容、来源与体积；不修改输入、不截断内容。
 */
export function buildHandoffContextPreview(packetLike: {
  context: HandoffContextItem[];
}): HandoffContextPreview {
  const items = packetLike.context.map((item) => ({
    itemId: item.id,
    label: item.label,
    content: item.content,
    sensitivity: item.sensitivity,
    included: item.included,
    inclusion: item.inclusion,
    provenance: item.provenance.map(handoffObjectRefKey),
    bytes: handoffContextItemByteLength(item.content),
  }));
  const violations = collectHandoffContextLimitViolations(packetLike.context);
  return {
    items,
    includedCount: items.filter((item) => item.included).length,
    excludedCount: items.filter((item) => !item.included).length,
    includedBytes: sumIncludedHandoffContextBytes(packetLike.context),
    limits: HANDOFF_CONTEXT_LIMITS,
    withinLimits: violations.length === 0,
    violations,
  };
}

/** 编辑原语共用的最小形状：只承诺 context 数组，避免与 packet 模块循环依赖。 */
export interface HandoffContextHolder {
  context: HandoffContextItem[];
}

function updateContextItem<T extends HandoffContextHolder>(
  packet: T,
  itemId: string,
  update: (item: HandoffContextItem) => HandoffContextItem,
): T {
  let found = false;
  const context = packet.context.map((item) => {
    if (item.id !== itemId) {
      return item;
    }
    found = true;
    return update(item);
  });
  if (!found) {
    throw new HandoffContractError(
      "handoff_context_item_not_found",
      `context item not found: ${itemId}`,
    );
  }
  return { ...packet, context } as T;
}

/**
 * 勾选/取消勾选一个上下文项。by 记录决策来源：用户手选必须传 "user"（默认），
 * 这同时满足「非 standard 内容需要显式包含」的准入规则。
 */
export function setHandoffContextItemIncluded<T extends HandoffContextHolder>(
  packet: T,
  itemId: string,
  included: boolean,
  by: HandoffContextInclusion = "user",
): T {
  return updateContextItem(packet, itemId, (item) => ({ ...item, included, inclusion: by }));
}

/** 编辑一个上下文项的内容（用户可改写在预览中看到/携带的文字）。 */
export function updateHandoffContextItemContent<T extends HandoffContextHolder>(
  packet: T,
  itemId: string,
  content: string,
): T {
  return updateContextItem(packet, itemId, (item) => {
    const parsed = handoffContextItemSchema.safeParse({ ...item, content });
    if (!parsed.success) {
      throw new HandoffContractError(
        "handoff_context_item_invalid",
        `invalid handoff context item content: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    return parsed.data;
  });
}

/** 移除一个上下文项（连同其携带状态一起从转移中移除）。 */
export function removeHandoffContextItem<T extends HandoffContextHolder>(
  packet: T,
  itemId: string,
): T {
  let found = false;
  const context = packet.context.filter((item) => {
    if (item.id === itemId) {
      found = true;
      return false;
    }
    return true;
  });
  if (!found) {
    throw new HandoffContractError(
      "handoff_context_item_not_found",
      `context item not found: ${itemId}`,
    );
  }
  return { ...packet, context } as T;
}

/** 追加一个上下文项；默认选择策略同 createHandoffContextItem（非 standard 默认排除）。 */
export function addHandoffContextItem<T extends HandoffContextHolder>(
  packet: T,
  input: NewHandoffContextItemInput,
): T {
  if (packet.context.length >= HANDOFF_CONTEXT_LIMITS.maxItems) {
    throw new HandoffContractError(
      "handoff_context_items_limit",
      `context already holds ${packet.context.length} items (limit ${HANDOFF_CONTEXT_LIMITS.maxItems})`,
    );
  }
  const item = createHandoffContextItem(input);
  if (packet.context.some((current) => current.id === item.id)) {
    throw new HandoffContractError(
      "handoff_context_item_invalid",
      `context item id already exists: ${item.id}`,
    );
  }
  return { ...packet, context: [...packet.context, item] } as T;
}
