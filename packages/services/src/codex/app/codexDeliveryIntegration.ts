// Codex 用户点名交付（app 层）：turn 完成后把"用户点名、且该轮 fileChange 实际产生"
// 的文件注册成 task artifact 并追加 artifact 行。
//
// 注册失败只降级为日志——没有 artifact 行，会话就绝不会宣称文件已交付。
// MIME 由扩展名 allowlist 决定；不在表内的文件 fail closed 跳过注册。
import path from "node:path";
import { taskArtifactMimeForFileName } from "@zcode/shared";
import type { ITaskArtifactRegistry } from "#src/task-artifacts/contract.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { selectUserNamedDeliverables } from "../domain/codexDelivery.js";
import type { CodexProjectionCommit } from "../domain/codexProjection.js";
import type { CodexThreadProjection } from "../domain/codexProjection.js";

const logger = createServiceLogger("codex-execution");

/**
 * 冷恢复把 Codex 历史归入 codex-history 组；本任务已注册的 artifact 以任务级尾部行
 * 重新出现（turnId 归属随重启丢失是已知边界，卡片仍可取回内容）。
 */
export async function reanchorRegisteredArtifactsAfterRebuild(options: {
  registry?: ITaskArtifactRegistry;
  taskId: string;
  projection: CodexThreadProjection;
}): Promise<void> {
  const { registry, taskId, projection } = options;
  if (!registry) return;
  try {
    const registered = await registry.listAllTaskArtifacts(taskId);
    for (const descriptor of registered) {
      if (descriptor.state === "available") projection.appendArtifactRow(descriptor, null);
    }
  } catch (error) {
    logger.warn(undefined, `codex artifact re-anchoring failed: ${String(error)}`);
  }
}

export async function deliverUserNamedCodexArtifacts(options: {
  registry: ITaskArtifactRegistry;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  projection: CodexThreadProjection;
  delivery: { turnId: string; userInputText: string; filePaths: string[] };
  emitCommit(taskId: string, commit: CodexProjectionCommit): void;
}): Promise<void> {
  const { registry, taskId, workspacePath, workspaceIdentity, projection, delivery, emitCommit } =
    options;
  const namedPaths = selectUserNamedDeliverables({
    userInputText: delivery.userInputText,
    filePaths: delivery.filePaths,
  });
  for (const relPath of namedPaths) {
    const normalized = relPath.replace(/\\/gu, "/");
    // 越出 workspace 的路径（../）永不注册：交付只能交付工作区内的产出物。
    if (normalized.split("/").includes("..")) continue;
    const fileName = normalized.split("/").at(-1) ?? "";
    const mimeType = taskArtifactMimeForFileName(fileName);
    if (!mimeType) continue; // 扩展名不在 allowlist：fail closed，不注册
    try {
      const registration = await registry.registerTaskArtifact({
        taskId,
        scope: {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        },
        origin: "codex",
        fileName,
        mimeType,
        hostPath: path.join(workspacePath, normalized),
        turnId: delivery.turnId,
      });
      const commit = projection.appendArtifactRow(registration.artifact, delivery.turnId);
      emitCommit(taskId, commit);
    } catch (error) {
      logger.warn(
        undefined,
        `codex artifact registration failed (delivery not claimed): ${String(error)}`,
      );
    }
  }
}
