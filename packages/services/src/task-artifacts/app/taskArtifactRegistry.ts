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
import { getAppConfigDir } from "#src/paths.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { isUuidLike, resolveTaskArtifactScope } from "./taskArtifactScope.js";

const logger = createServiceLogger("task-artifacts");

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

export { isUuidLike, resolveTaskArtifactScope };

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
  /**
   * store 根目录；缺省每次操作时解析 `<getAppConfigDir()>/task-artifacts`，跟随进程数据根
   * （custom fork dev host 下即 `~/.zcode-fork-dev-home/.zcode/v2/task-artifacts`）。测试注入临时目录。
   */
  readonly rootDir?: string;
  readonly now?: () => number;
}

/**
 * 注册表。字节落盘为 `<root>/<taskId>/<artifactId>.bin`，元数据在
 * `<root>/<taskId>/index.json`（整文件原子重写；条目少，无并发写者）。
 */
export class TaskArtifactRegistry {
  readonly #rootDirOverride: string | undefined;
  readonly #now: () => number;
  /** One host owns a registry; serialize read→dedupe→write per task to make replay idempotent. */
  readonly #taskWriteLocks = new Map<string, Promise<void>>();

  constructor(deps: TaskArtifactStoreDeps = {}) {
    this.#rootDirOverride = deps.rootDir;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** 每次解析，避免构造时刻早于 setDataBaseDir 而把 store 固定在错误的数据根。 */
  get rootDir(): string {
    return this.#rootDirOverride ?? path.join(getAppConfigDir(), "task-artifacts");
  }

  /** 检索面的 scope 解析：非法 id 与未注册同一错误码，不向调用方泄露区别。 */
  #canonicalTaskId(taskId: string): string {
    const scope = resolveTaskArtifactScope(taskId);
    if (!scope) throw new TaskArtifactRetrievalError(TASK_ARTIFACT_FAULT_CODES.notRegistered);
    return scope.canonicalTaskId;
  }

  // root 由每个公开操作解析一次后传入：单次操作内数据根切换不会让 bytes 与 index 落到不同根。
  #taskDir(root: string, taskId: string): string {
    return path.join(root, this.#canonicalTaskId(taskId));
  }

  #bytesPath(root: string, taskId: string, artifactId: string): string {
    if (!isUuidLike(artifactId)) {
      throw new TaskArtifactRetrievalError(TASK_ARTIFACT_FAULT_CODES.notRegistered);
    }
    // 双重保险：两个分量都已被 UUID 形状校验（taskId 经规范化），join 结果不可能逃出 root。
    return path.join(this.#taskDir(root, taskId), `${artifactId}.bin`);
  }

  async #readIndex(root: string, taskId: string): Promise<TaskIndexFile> {
    try {
      const raw = await readFile(path.join(this.#taskDir(root, taskId), "index.json"), "utf8");
      const parsed = JSON.parse(raw) as TaskIndexFile;
      return { artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [] };
    } catch {
      return { artifacts: [] };
    }
  }

  async #writeIndex(root: string, taskId: string, index: TaskIndexFile): Promise<void> {
    await mkdir(this.#taskDir(root, taskId), { recursive: true });
    const target = path.join(this.#taskDir(root, taskId), "index.json");
    // 原子重写：写同目录 temp 后 rename 覆盖，避免读到半截 index。
    const temp = path.join(this.#taskDir(root, taskId), `index.json.tmp-${randomUUID()}`);
    await writeFile(temp, JSON.stringify(index), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(temp, target);
  }

  /** 注册：校验 → 复制字节 → 建索引。失败抛 TaskArtifactRegistrationError，绝不宣称交付。
   *  幂等：同任务内 sha256+origin+turnId 完全一致的重复注册返回既有条目（agent 重试、
   *  连接重放不会产生重复 artifact）。 */
  async #withTaskWriteLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#taskWriteLocks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#taskWriteLocks.set(taskId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#taskWriteLocks.get(taskId) === queued) this.#taskWriteLocks.delete(taskId);
    }
  }

  async registerTaskArtifact(
    params: TaskArtifactRegistration,
  ): Promise<TaskArtifactRegistrationResult> {
    const scope = resolveTaskArtifactScope(params.taskId);
    if (!scope) {
      throw new TaskArtifactRegistrationError(
        "artifact_invalid_scope",
        "taskId must be a UUID or sess_<uuid>",
      );
    }
    // 锁按规范 UUID：同一任务的 UUID 与 sess_ 两种写法共享一次 read→dedupe→write 串行化。
    const root = this.rootDir;
    return this.#withTaskWriteLock(scope.canonicalTaskId, () =>
      this.#registerTaskArtifact(params, root),
    );
  }

  async #registerTaskArtifact(
    params: TaskArtifactRegistration,
    root: string,
  ): Promise<TaskArtifactRegistrationResult> {
    const scopeKey = resolveWorkspaceKey({
      workspacePath: params.scope.workspacePath,
      workspaceIdentity: params.scope.workspaceIdentity,
    });
    if (!scopeKey?.trim()) {
      throw new TaskArtifactRegistrationError("artifact_invalid_scope");
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
    const index = await this.#readIndex(root, params.taskId);
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
          existsSync(this.#bytesPath(root, params.taskId, existing.artifactId)),
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

    await mkdir(this.#taskDir(root, params.taskId), { recursive: true });
    await writeFile(this.#bytesPath(root, params.taskId, artifactId), bytes);
    index.artifacts.push(meta);
    await this.#writeIndex(root, params.taskId, index);
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
    const root = this.rootDir;
    const scopeKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const index = await this.#readIndex(root, params.taskId);
    const artifacts = index.artifacts
      .filter((meta) => meta.workspaceKey === scopeKey)
      .map((meta) =>
        descriptorOf(meta, existsSync(this.#bytesPath(root, params.taskId, meta.artifactId))),
      );
    return { artifacts };
  }

  async readTaskArtifact(params: TaskArtifactReadParams): Promise<TaskArtifactReadResult> {
    const root = this.rootDir;
    const scopeKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const index = await this.#readIndex(root, params.taskId);
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
      bytes = await readFile(this.#bytesPath(root, params.taskId, params.artifactId));
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
    const root = this.rootDir;
    const index = await this.#readIndex(root, params.taskId);
    return index.artifacts.find((candidate) => candidate.artifactId === params.artifactId) ?? null;
  }

  /** 宿主内部全量清单（不做 scope 收敛；供投影冷恢复重建 artifact 行）。 */
  async listAllTaskArtifacts(taskId: string): Promise<readonly TaskArtifactDescriptor[]> {
    const root = this.rootDir;
    const index = await this.#readIndex(root, taskId);
    return index.artifacts.map((meta) =>
      descriptorOf(meta, existsSync(this.#bytesPath(root, taskId, meta.artifactId))),
    );
  }

  dispose(): void {
    // 无持久句柄；为宿主关停链保留对称接口。
  }
}
