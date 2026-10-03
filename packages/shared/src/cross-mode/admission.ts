import { HandoffContractError } from "./errors.js";
import { HandoffFlowError } from "./flow-errors.js";
import {
  deserializeHandoffPacket,
  validateHandoffPacketTransfer,
  type HandoffPacket,
} from "./handoff-packet.js";
import type { HandoffReturnSummary } from "./handoff-return.js";
import type { AceVraMode, HandoffObjectRef } from "./modes.js";
import type { HandoffExecutionPort } from "./ports.js";
import type { HandoffConfirmation } from "./preview-session.js";

/**
 * M2 准入流程（隔离实现）：确认快照 → 重新校验 → 记录 dispatched → 经执行端口派发 → 记录结果。
 *
 * 所有权：
 * - cross-mode 拥有 handoff 准入记录（唯一所有者）；
 * - 目的侧工作（session / run / 任何执行体）由 HandoffExecutionPort 实现方拥有，
 *   流程层只保存 externalRef 回链，不触碰目的侧状态。
 *
 * 集成点隔离：执行端口与持久化 store 都是可替换端口。默认提供内存实现，
 * 供本里程碑与测试使用；宿主适配器在兄弟分支稳定后接入。
 */

export const HANDOFF_ADMISSION_STATUSES = [
  "dispatched",
  "accepted",
  "rejected",
  "returned",
] as const;
export type HandoffAdmissionStatus = (typeof HANDOFF_ADMISSION_STATUSES)[number];

export interface HandoffAdmissionRecord {
  readonly handoffId: string;
  readonly sourceMode: AceVraMode;
  readonly destinationMode: AceVraMode;
  readonly objective: string;
  readonly status: HandoffAdmissionStatus;
  /** 派发尝试次数；rejected 后允许重新准入（attempts 递增）。 */
  readonly attempts: number;
  readonly dispatchedAt: number;
  readonly resolvedAt: number | null;
  /** 目的侧工作引用（accepted 起可用），用于回链与状态卡。 */
  readonly externalRef: HandoffObjectRef | null;
  readonly rejectionReason: string | null;
  /** Multitask→Coding / Work→Bot 的返回摘要（returned 起可用）。 */
  readonly returnSummary: HandoffReturnSummary | null;
}

/** 准入记录存储端口：M2 提供内存实现；宿主持久化适配器是后续集成点。 */
export interface HandoffAdmissionStore {
  read(handoffId: string): Promise<HandoffAdmissionRecord | null>;
  write(record: HandoffAdmissionRecord): Promise<void>;
  list(): Promise<HandoffAdmissionRecord[]>;
}

export function createInMemoryHandoffAdmissionStore(): HandoffAdmissionStore {
  const records = new Map<string, HandoffAdmissionRecord>();
  return {
    async read(handoffId) {
      return records.get(handoffId) ?? null;
    },
    async write(record) {
      records.set(record.handoffId, record);
    },
    async list() {
      return [...records.values()];
    },
  };
}

export interface HandoffAdmissionService {
  admit(confirmation: HandoffConfirmation): Promise<HandoffAdmissionRecord>;
  recordReturn(summary: HandoffReturnSummary): Promise<HandoffAdmissionRecord>;
  get(handoffId: string): Promise<HandoffAdmissionRecord | null>;
  list(): Promise<HandoffAdmissionRecord[]>;
}

export interface HandoffAdmissionServiceDeps {
  readonly execution: HandoffExecutionPort;
  readonly store?: HandoffAdmissionStore;
  readonly now?: () => number;
}

function parseConfirmedPacket(confirmation: HandoffConfirmation): HandoffPacket {
  let packet: HandoffPacket;
  try {
    packet = deserializeHandoffPacket(confirmation.packetJson);
  } catch (error) {
    if (error instanceof HandoffContractError) {
      throw new HandoffFlowError(
        "handoff_flow_invalid_confirmation",
        `confirmation snapshot is not parseable: ${error.message}`,
        error.issues,
      );
    }
    throw error;
  }
  if (packet.handoffId !== confirmation.handoffId) {
    throw new HandoffFlowError(
      "handoff_flow_invalid_confirmation",
      "confirmation snapshot does not match its handoffId",
    );
  }
  return packet;
}

export function createHandoffAdmissionService(
  deps: HandoffAdmissionServiceDeps,
): HandoffAdmissionService {
  const store = deps.store ?? createInMemoryHandoffAdmissionStore();
  const now = deps.now ?? (() => Date.now());

  return {
    async admit(confirmation) {
      // 防御性复查：确认快照必须仍能通过解析与准入校验（与预览确认同一份规则）。
      const packet = parseConfirmedPacket(confirmation);
      const errors = validateHandoffPacketTransfer(packet).filter(
        (issue) => issue.severity === "error",
      );
      if (errors.length > 0) {
        throw new HandoffFlowError(
          "handoff_flow_invalid_confirmation",
          "confirmed packet is not transferable",
          errors,
        );
      }

      const existing = await store.read(confirmation.handoffId);
      if (existing && existing.status !== "rejected") {
        throw new HandoffFlowError(
          "handoff_flow_already_admitted",
          `handoff ${confirmation.handoffId} is already admitted (status: ${existing.status})`,
        );
      }

      const dispatched: HandoffAdmissionRecord = {
        handoffId: confirmation.handoffId,
        sourceMode: packet.sourceMode,
        destinationMode: packet.destinationMode,
        objective: packet.objective,
        status: "dispatched",
        attempts: (existing?.attempts ?? 0) + 1,
        dispatchedAt: now(),
        resolvedAt: null,
        externalRef: null,
        rejectionReason: null,
        returnSummary: null,
      };
      // 先落 dispatched 再派发：进行中的状态对读取方可见（状态卡/恢复用）。
      await store.write(dispatched);

      const outcome = await deps.execution.execute({
        packet,
        confirmedAt: confirmation.confirmedAt,
      });
      const resolved: HandoffAdmissionRecord =
        outcome.status === "accepted"
          ? {
              ...dispatched,
              status: "accepted",
              resolvedAt: now(),
              externalRef: outcome.externalRef,
            }
          : {
              ...dispatched,
              status: "rejected",
              resolvedAt: now(),
              rejectionReason: outcome.reason,
            };
      await store.write(resolved);
      return resolved;
    },

    async recordReturn(summary) {
      const record = await store.read(summary.handoffId);
      if (!record) {
        throw new HandoffFlowError(
          "handoff_flow_unknown_handoff",
          `no admission record for handoff ${summary.handoffId}`,
        );
      }
      if (record.returnSummary) {
        throw new HandoffFlowError(
          "handoff_flow_already_returned",
          `handoff ${summary.handoffId} already has a return summary`,
        );
      }
      const updated: HandoffAdmissionRecord = {
        ...record,
        status: "returned",
        returnSummary: summary,
      };
      await store.write(updated);
      return updated;
    },

    get(handoffId) {
      return store.read(handoffId);
    },

    list() {
      return store.list();
    },
  };
}
