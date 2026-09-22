// Task artifact registry（app 层，宿主内部）。
//
// 职责：注册（校验 + 复制 + 建索引）、清单、分块读取。字节复制进 registry store 后，
// 原始宿主路径即被丢弃——检索面只认 (taskId, artifactId)，从结构上排除路径穿越。
//
// SECURITY BOUNDARY：本文件是 task-artifacts 的授权边界。检索面（list/read）必须：
// 1) taskId/artifactId 匹配 UUID 形状（分隔符/.. 在形状检查即被拒绝）；
// 2) workspaceKey 与注册范围一致；
// 3) 描述符/错误一律不含宿主路径。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  TaskArtifactDescriptor,
  TaskArtifactListParams,
  TaskArtifactReadParams,
  TaskArtifactReadResult,
  TaskArtifactRegistration,
  TaskArtifactRegistrationFailure,
  TaskArtifactRegistrationResult,
} from "@zcode/shared";
import {
  TASK_ARTIFACT_MAX_BYTES,
  TASK_ARTIFACT_FAULT_CODES,
  isAllowedTaskArtifactMimeType,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { resolveWorkspaceKey } from "@zcode/shared";
import { getDataBaseDir } from "#src/paths.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("task-artifacts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** 单读 chunk 上限：与 v4 attachment 分块上限对齐，独立声明避免耦合漂移。 */
const READ_CHUNK_MAX_BYTES = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;

interface StoredArtifactMeta {
  artifactId: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  origin: TaskArtifactDescriptor["origin"];
  createdAt: number;
  turnId?: string;
  workspaceKey: string;
}

interface TaskIndexFile {
  artifacts: StoredArtifactMeta[];
}

export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value);
}

export function fileNameFromPath(hostPath: string): string {
  return hostPath.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1) ?? hostPath;
}

export class TaskArtifactRegistrationError extends Error {
  readonly reasonCode: TaskArtifactRegistrationFailure;
  constructor(reasonCode: TaskArtifactRegistrationFailure, message?: string) {
    super(message ?? reasonCode);
    this.reasonCode = reasonCode;
  }
}

export class TaskArtifactRetrievalError extends Error {
  readonly code: (typeof TASK_ARTIFACT_FAULT_CODES)[keyof typeof TASK_ARTIFACT_FAULT_CODES];
  constructor(code: TaskArtifactRetrievalError["code"], message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

function descriptorOf(meta: StoredArtifactMeta, backingExists: boolean): TaskArtifactDescriptor {
  return {
    artifactId: meta.artifactId,
    taskId: meta.taskId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    byteSize: meta.byteSize,
    sha256: meta.sha256,
    origin: meta.origin,
    createdAt: meta.createdAt,
    state: backingExists ? "available" : "missing",
  };
}

export interface TaskArtifactStoreDeps {
  /** store 根目录；缺省 `<dataBaseDir>/task-artifacts`。测试注入临时目录。 */
  readonly rootDir?: string;
  readonly now?: () => number;
}

/**
 * 注册表。字节落盘为 `<root>/<taskId>/<artifactId>.bin`，元数据在
 * `<root>/<taskId>/index.json`（整文件原子重写；条目少，无并发写者）。
 */
export class TaskArtifactRegistry {
  readonly #rootDir: string;
  readonly #now: () => number;

  constructor(deps: TaskArtifactStoreDeps = {}) {
    this.#rootDir = deps.rootDir ?? path.join(this.#defaultRoot(), "task-artifacts");
    this.#now = deps.now ?? (() => Date.now());
  }

  #defaultRoot(): string {
    return getDataBaseDir();
  }

  get rootDir(): string {
    return this.#rootDir;
  }

  #taskDir(taskId: string): string {
    if (!isUuidLike(taskId)) {
      throw new TaskArtifactRetrievalError(TASK_ARTIFACT_FAULT_CODES.notRegistered);
    }
    return path.join(this.#rootDir, taskId);
  }

  #bytesPath(taskId: string, artifactId: string): string {
    if (!isUuidLike(artifactId)) {
      throw new TaskArtifactRetrievalError(TASK_ARTIFACT_FAULT_CODES.notRegistered);
    }
    // 双重保险：两个分量都已被 UUID 形状校验，join 结果不可能逃出 root。
    return path.join(this.#taskDir(taskId), `${artifactId}.bin`);
  }

  async #readIndex(taskId: string): Promise<TaskIndexFile> {
    try {
      const raw = await readFile(path.join(this.#taskDir(taskId), "index.json"), "utf8");
      const parsed = JSON.parse(raw) as TaskIndexFile;
      return { artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [] };
    } catch {
      return { artifacts: [] };
    }
  }

  async #writeIndex(taskId: string, index: TaskIndexFile): Promise<void> {
    await mkdir(this.#taskDir(taskId), { recursive: true });
    const target = path.join(this.#taskDir(taskId), "index.json");
    // 原子重写：写同目录 temp 后 rename 覆盖，避免读到半截 index。
    const temp = path.join(this.#taskDir(taskId), `index.json.tmp-${randomUUID()}`);
    await writeFile(temp, JSON.stringify(index), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(temp, target);
  }

  /** 注册：校验 → 复制字节 → 建索引。失败抛 TaskArtifactRegistrationError，绝不宣称交付。
   *  幂等：同任务内 sha256+origin+turnId 完全一致的重复注册返回既有条目（agent 重试、
   *  连接重放不会产生重复 artifact）。 */
  async registerTaskArtifact(
    params: TaskArtifactRegistration,
  ): Promise<TaskArtifactRegistrationResult> {
    const scopeKey = resolveWorkspaceKey({
      workspacePath: params.scope.workspacePath,
      workspaceIdentity: params.scope.workspaceIdentity,
    });
    if (!scopeKey?.trim()) {
      throw new TaskArtifactRegistrationError("artifact_invalid_scope");
    }
    if (!isUuidLike(params.taskId)) {
      throw new TaskArtifactRegistrationError("artifact_invalid_scope", "taskId must be a UUID");
    }
    const fileName = params.fileName.trim();
    if (
      !fileName ||
      fileName.includes("/") ||
      fileName.includes("\\") ||
      fileName.includes("..") ||
      fileName.length > 255
    ) {
      throw new TaskArtifactRegistrationError("artifact_invalid_filename");
    }
    const mimeType = params.mimeType.trim().toLowerCase();
    if (!isAllowedTaskArtifactMimeType(mimeType)) {
      throw new TaskArtifactRegistrationError("artifact_mime_not_allowed", mimeType);
    }

    let bytes: Uint8Array;
    if (params.bytes !== undefined) {
      bytes = params.bytes;
    } else if (params.hostPath !== undefined) {
      // 宿主路径仅此一处使用：stat 校验 + 有界读取，随后即弃。
      try {
        const info = await stat(params.hostPath);
        if (!info.isFile()) {
          throw new TaskArtifactRegistrationError("artifact_source_missing");
        }
        if (info.size > TASK_ARTIFACT_MAX_BYTES) {
          throw new TaskArtifactRegistrationError("artifact_too_large");
        }
        bytes = new Uint8Array(await readFile(params.hostPath));
      } catch (error) {
        if (error instanceof TaskArtifactRegistrationError) throw error;
        throw new TaskArtifactRegistrationError("artifact_source_missing");
      }
    } else {
      throw new TaskArtifactRegistrationError("artifact_source_missing", "no content provided");
    }

    if (bytes.byteLength === 0 || bytes.byteLength > TASK_ARTIFACT_MAX_BYTES) {
      throw new TaskArtifactRegistrationError("artifact_too_large");
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const index = await this.#readIndex(params.taskId);
    const scopeKeyForIndex = resolveWorkspaceKey({
      workspacePath: params.scope.workspacePath,
      workspaceIdentity: params.scope.workspaceIdentity,
    });
    const existing = index.artifacts.find(
      (candidate) =>
        candidate.sha256 === sha256 &&
        candidate.origin === params.origin &&
        (candidate.turnId ?? "") === (params.turnId ?? "") &&
        candidate.workspaceKey === scopeKeyForIndex,
    );
    if (existing) {
      return {
        artifact: descriptorOf(
          existing,
          existsSync(this.#bytesPath(params.taskId, existing.artifactId)),
        ),
        ...(params.turnId ? { turnId: params.turnId } : {}),
      };
    }

    const artifactId = randomUUID();
    const meta: StoredArtifactMeta = {
      artifactId,
      taskId: params.taskId,
      fileName,
      mimeType,
      byteSize: bytes.byteLength,
      sha256,
      origin: params.origin,
      createdAt: params.now ?? this.#now(),
      ...(params.turnId ? { turnId: params.turnId } : {}),
      workspaceKey: scopeKey,
    };

    await mkdir(this.#taskDir(params.taskId), { recursive: true });
    await writeFile(this.#bytesPath(params.taskId, artifactId), bytes);
    index.artifacts.push(meta);
    await this.#writeIndex(params.taskId, index);
    logger.info(
      undefined,
      `task artifact registered taskId=${params.taskId} origin=${meta.origin} bytes=${meta.byteSize}`,
    );
    return {
      artifact: descriptorOf(meta, true),
      ...(params.turnId ? { turnId: params.turnId } : {}),
    };
  }

  async listTaskArtifacts(
    params: TaskArtifactListParams,
  ): Promise<{ artifacts: readonly TaskArtifactDescriptor[] }> {
    const scopeKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const index = await this.#readIndex(params.taskId);
    const artifacts = index.artifacts
      .filter((meta) => meta.workspaceKey === scopeKey)
      .map((meta) =>
        descriptorOf(meta, existsSync(this.#bytesPath(params.taskId, meta.artifactId))),
      );
    return { artifacts };
  }

  async readTaskArtifact(params: TaskArtifactReadParams): Promise<TaskArtifactReadResult> {
    const scopeKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const index = await this.#readIndex(params.taskId);
    const meta = index.artifacts.find(
      (candidate) =>
        candidate.artifactId === params.artifactId && candidate.workspaceKey === scopeKey,
    );
    // 未注册/越权一律同一错误码：不向调用方区分“存在但不属于你”。
    if (!meta) {
      throw new TaskArtifactRetrievalError(TASK_ARTIFACT_FAULT_CODES.notRegistered);
    }
    const offset = Math.max(0, Math.floor(params.offset));
    const limit = Math.min(
      READ_CHUNK_MAX_BYTES,
      Math.max(1, Math.floor(params.limit ?? READ_CHUNK_MAX_BYTES)),
    );
    let bytes: Buffer;
    try {
      bytes = await readFile(this.#bytesPath(params.taskId, params.artifactId));
    } catch {
      throw new TaskArtifactRetrievalError(TASK_ARTIFACT_FAULT_CODES.backingMissing);
    }
    if (offset > bytes.byteLength) {
      throw new TaskArtifactRetrievalError(TASK_ARTIFACT_FAULT_CODES.badOffset);
    }
    if (offset === bytes.byteLength) {
      return {
        dataBase64: "",
        totalBytes: bytes.byteLength,
        mediaType: meta.mimeType,
        nextOffset: null,
      };
    }
    const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + limit));
    const next = offset + slice.byteLength;
    return {
      dataBase64: slice.toString("base64"),
      totalBytes: bytes.byteLength,
      mediaType: meta.mimeType,
      nextOffset: next < bytes.byteLength ? next : null,
    };
  }

  /** 读取单个注册项的完整元信息（宿主内部；供投影 append artifact row 使用）。 */
  async getTaskArtifactMeta(params: {
    taskId: string;
    artifactId: string;
  }): Promise<StoredArtifactMeta | null> {
    const index = await this.#readIndex(params.taskId);
    return (
      index.artifacts.find((candidate) => candidate.artifactId === params.artifactId) ?? null
    );
  }

  /** 宿主内部全量清单（不做 scope 收敛；供投影冷恢复重建 artifact 行）。 */
  async listAllTaskArtifacts(taskId: string): Promise<readonly TaskArtifactDescriptor[]> {
    const index = await this.#readIndex(taskId);
    return index.artifacts.map((meta) =>
      descriptorOf(meta, existsSync(this.#bytesPath(taskId, meta.artifactId))),
    );
  }

  dispose(): void {
    // 无持久句柄；为宿主关停链保留对称接口。
  }
}
