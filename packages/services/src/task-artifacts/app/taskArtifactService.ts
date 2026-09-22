// Task artifacts 服务契约（app 层）。
//
// SECURITY BOUNDARY：ITaskArtifactDeliveryService 是 task-artifacts 通道的完整表面，
// 只有清单与分块读取两个方法。注册（registerTaskArtifact）是宿主内部能力（browser-use
// 桥、Codex 投影），通过 ITaskArtifactRegistry 提供，node.ts 只把 delivery facade
// 注册到通道上——远端客户端永远无法注册 artifact 或触发任意宿主文件读取。
// 描述符与错误不含宿主绝对路径。
import { ServiceChannels } from "@zcode/shared";
import type {
  TaskArtifactDescriptor,
  TaskArtifactListParams,
  TaskArtifactListResult,
  TaskArtifactReadParams,
  TaskArtifactReadResult,
  TaskArtifactRegistration,
  TaskArtifactRegistrationResult,
} from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

/** 通道面：清单 + 分块读取（已注册 artifact，按任务范围收敛）。 */
export interface ITaskArtifactDeliveryService {
  listTaskArtifacts(params: TaskArtifactListParams): Promise<TaskArtifactListResult>;
  readTaskArtifact(params: TaskArtifactReadParams): Promise<TaskArtifactReadResult>;
}

export const ITaskArtifactDeliveryService = createServiceDescriptor<ITaskArtifactDeliveryService>(
  ServiceChannels.TaskArtifacts,
);

/** 宿主内部注册面；刻意不在通道上暴露。 */
export interface ITaskArtifactRegistry extends ITaskArtifactDeliveryService {
  registerTaskArtifact(
    params: TaskArtifactRegistration,
  ): Promise<TaskArtifactRegistrationResult>;
  /** 宿主内部：不做 scope 收敛的全量清单（投影冷恢复重建 artifact 行用）。 */
  listAllTaskArtifacts(taskId: string): Promise<
    readonly import("@zcode/shared").TaskArtifactDescriptor[]
  >;
  getTaskArtifactMeta(params: {
    taskId: string;
    artifactId: string;
  }): Promise<{
    artifactId: string;
    taskId: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    origin: TaskArtifactDescriptor["origin"];
    createdAt: number;
    turnId?: string;
  } | null>;
  dispose(): void;
}
