// Task artifacts（phase 11）：工具/agent 结构化输出的远程投递契约。
//
// SECURITY BOUNDARY：本文件是 task-artifacts 通道允许跨进程（含 /fork relay）传输的
// 全部形状。描述符只携带不透明 artifactId 与展示元信息；宿主绝对路径、原始注册来源
// 路径、registry 内部布局一律不得进入这些类型。字节只经 readTaskArtifact 分块读取。
//
// 注册（registerTaskArtifact）是宿主内部能力（browser-use 桥、Codex 投影），刻意
// 不在本通道上暴露：远端客户端不能把任意宿主文件注册成可取回 artifact。

import { z } from "zod";

/** artifact 的注册来源。 */
export type TaskArtifactOrigin = "browser-use" | "codex" | "tool";

export const TASK_ARTIFACT_ORIGINS: readonly TaskArtifactOrigin[] = [
  "browser-use",
  "codex",
  "tool",
];

/** 可内联预览的图片 MIME；其余注册类型走下载卡片。 */
export const INLINE_PREVIEW_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** 注册时的 MIME allowlist；不在表内的注册被拒绝（fail closed）。 */
export const TASK_ARTIFACT_MIME_ALLOWLIST: readonly string[] = [
  ...INLINE_PREVIEW_MIME_TYPES,
  "application/pdf",
  "application/zip",
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
];

export function isInlinePreviewMimeType(mimeType: string): boolean {
  return INLINE_PREVIEW_MIME_TYPES.includes(mimeType.toLowerCase());
}

export function isAllowedTaskArtifactMimeType(mimeType: string): boolean {
  return TASK_ARTIFACT_MIME_ALLOWLIST.includes(mimeType.toLowerCase());
}

/**
 * 注册上限：单 artifact 字节数。取值刻意与 v4 分享能力的量级一致但独立声明，
 * 避免 task-artifacts 与分享能力互相耦合。
 */
export const TASK_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

/** 注册成功的描述符。hostPath 永不出现在此形状上。 */
export interface TaskArtifactDescriptor {
  readonly artifactId: string;
  readonly taskId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly origin: TaskArtifactOrigin;
  readonly createdAt: number;
  /** backIng 文件缺失时的降态标记；仍不可取回内容。 */
  readonly state: "available" | "missing";
}

/** 注册时必须携带的任务范围；检索时按同一 workspaceKey 收敛。 */
export interface TaskArtifactScope {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}

export interface TaskArtifactListParams extends TaskArtifactScope {
  readonly taskId: string;
}

export interface TaskArtifactListResult {
  readonly artifacts: readonly TaskArtifactDescriptor[];
}

export interface TaskArtifactReadParams extends TaskArtifactScope {
  readonly taskId: string;
  readonly artifactId: string;
  readonly offset: number;
  /** 缺省/0 视为服务端默认 chunk 上限；服务端按上限截断。 */
  readonly limit?: number;
}

export interface TaskArtifactReadResult {
  readonly dataBase64: string;
  readonly totalBytes: number;
  readonly mediaType: string;
  readonly nextOffset: number | null;
}

/** 注册入参：bytes 与 hostPath 二选一；hostPath 仅限宿主内部调用方传入。 */
export interface TaskArtifactRegistration {
  readonly taskId: string;
  readonly scope: TaskArtifactScope;
  readonly origin: TaskArtifactOrigin;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes?: Uint8Array;
  /** 宿主本地文件；存在性/大小校验后复制进 store，原路径不落任何持久状态。 */
  readonly hostPath?: string;
  /** 产出该 artifact 的 turn；用于渲染端把卡片锚定到对应轮。 */
  readonly turnId?: string;
  readonly now?: number;
}

export interface TaskArtifactRegistrationResult {
  readonly artifact: TaskArtifactDescriptor;
  readonly turnId?: string;
}

/** 注册失败的稳定 reasonCode；调用方据此决定是否宣称交付成功。 */
export type TaskArtifactRegistrationFailure =
  | "artifact_invalid_scope"
  | "artifact_invalid_filename"
  | "artifact_mime_not_allowed"
  | "artifact_too_large"
  | "artifact_source_missing"
  | "artifact_source_unreadable"
  | "artifact_task_unknown";

export const TASK_ARTIFACT_FAULT_CODES = {
  notFound: "artifact_not_found",
  notRegistered: "artifact_not_registered",
  scopeMismatch: "artifact_scope_mismatch",
  badOffset: "artifact_bad_offset",
  backingMissing: "artifact_backing_missing",
  tooLarge: "artifact_too_large",
} as const;

/** 文件名 → MIME（注册 allowlist 内）；未知扩展返回 null（调用方 fail closed 跳过注册）。 */
export function taskArtifactMimeForFileName(fileName: string): string | null {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const byExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    htm: "text/html",
    csv: "text/csv",
    json: "application/json",
  };
  return byExtension[extension] ?? null;
}

/** MIME → v4 artifact 行的 artifactType（行枚举没有 zip/json 等变体，归入 "file"）。 */
export function taskArtifactRowType(
  mimeType: string,
): "image" | "pdf" | "md" | "html" | "text" | "file" {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/markdown") return "md";
  if (normalized === "text/html") return "html";
  if (normalized.startsWith("text/")) return "text";
  return "file";
}

// ── 运行时校验（通道面） ──

export const taskArtifactDescriptorSchema = z.object({
  artifactId: z.string().uuid(),
  taskId: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  origin: z.enum(["browser-use", "codex", "tool"]),
  createdAt: z.number().int().nonnegative(),
  state: z.enum(["available", "missing"]),
});

export const taskArtifactReadParamsSchema = z.object({
  taskId: z.string().min(1),
  artifactId: z.string().uuid(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(1024 * 1024).optional(),
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().min(1).optional(),
});
