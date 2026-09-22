// Codex 用户点名交付判定（domain，纯函数，零推理）。
//
// 用户在 turn 输入里显式点名的文件才允许注册成 artifact：
// - 提取输入中的"带扩展名 token"（路径或 basename），
// - 与该轮 fileChange 的路径做精确匹配（basename 相等或以 /<name> 结尾）。
// 用户没有点名的源码编辑永远不注册——这是"不自动上传每次编辑"的确定性边界。

const NAMED_FILE_TOKEN_RE = /^[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8}$/u;

export function extractNamedFileTokens(userInputText: string): string[] {
  const named = new Set<string>();
  for (const token of userInputText.split(/[^A-Za-z0-9_.@-]+/u)) {
    if (
      token.length >= 3 &&
      token.length <= 255 &&
      !token.includes("..") &&
      NAMED_FILE_TOKEN_RE.test(token)
    ) {
      named.add(token.toLowerCase());
    }
  }
  return [...named];
}

export function selectUserNamedDeliverables(params: {
  userInputText: string;
  filePaths: readonly string[];
}): string[] {
  const named = new Set(extractNamedFileTokens(params.userInputText));
  if (named.size === 0) return [];
  const matched = new Set<string>();
  for (const filePath of params.filePaths) {
    const normalized = filePath.replace(/\\/gu, "/");
    const base = (normalized.split("/").at(-1) ?? "").toLowerCase();
    if (named.has(base)) {
      matched.add(filePath);
      continue;
    }
    for (const token of named) {
      if (normalized.toLowerCase().endsWith(`/${token}`)) {
        matched.add(filePath);
        break;
      }
    }
  }
  return [...matched];
}

import type { TaskArtifactDescriptor } from "@zcode/shared";
import type { ArtifactRow } from "@zcode/shared/zcode-protocol-v4";
import { taskArtifactRowType } from "@zcode/shared";
import { rowBase } from "./codexRowLog.js";

/** 每轮一次性的交付追踪：输入文本 + 该轮 fileChange 路径，turn 完成后取走。 */
export class CodexTurnDeliveryTracker {
  #current: { turnId: string; userInputText: string; filePaths: string[] } | null = null;

  beginTurn(turnId: string, userInputText: string): void {
    this.#current = { turnId, userInputText, filePaths: [] };
  }

  recordFileChangePaths(paths: readonly string[]): void {
    if (!this.#current) return;
    for (const filePath of paths) {
      if (filePath) this.#current.filePaths.push(filePath);
    }
  }

  takeCompleted(): { turnId: string; userInputText: string; filePaths: string[] } | null {
    const delivery = this.#current;
    this.#current = null;
    return delivery && delivery.filePaths.length > 0 ? delivery : null;
  }
}

/** 标准 artifact 行构造（ref 为 task-artifacts 授权引用；不含宿主路径）。 */
export function buildCodexArtifactRow(params: {
  descriptor: TaskArtifactDescriptor;
  turnId: string;
  rowId: number;
  createdAt: number;
}): ArtifactRow {
  const { descriptor, turnId, rowId, createdAt } = params;
  return {
    ...rowBase(rowId, turnId, `codex-artifact-${descriptor.artifactId}`, createdAt),
    kind: "artifact",
    artifactVersionId: `taskart-${descriptor.artifactId}`,
    logicalArtifactKey: `taskart-${descriptor.taskId}-${descriptor.sha256}`,
    displayName: descriptor.fileName,
    artifactType: taskArtifactRowType(descriptor.mimeType),
    mimeType: descriptor.mimeType,
    sizeBytes: descriptor.byteSize,
    sha256: descriptor.sha256,
    ref: `zcode-artifact://task/${descriptor.taskId}/${descriptor.artifactId}`,
    state: "current",
  };
}
