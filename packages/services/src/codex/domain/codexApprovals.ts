// Codex 审批登记表（domain，纯函数类）。
// 审批请求必须先落表并经 pendingInteraction 下发到 harness，才允许把决定发回 Codex；
// 未知的 interactionId 一律拒绝（resolve 返回 null），静默放行是安全红线。
import type { CodexExecutionApprovalDecision, CodexExecutionApprovalRequestInfo } from "@zcode/shared";
import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { buildCodexApprovalInteraction } from "./codexSnapshot.js";

export interface CodexApprovalRecord {
  readonly interactionId: string;
  readonly rawId: number;
  readonly info: CodexExecutionApprovalRequestInfo;
  readonly anchorRowId: number | null;
}

export interface CodexApprovalResolution {
  readonly record: CodexApprovalRecord;
  readonly decision: CodexExecutionApprovalDecision["decision"];
  readonly codexResponse: Record<string, unknown>;
}

export class CodexApprovalTable {
  readonly #records = new Map<string, CodexApprovalRecord>();
  #ordinal = 1;

  get size(): number {
    return this.#records.size;
  }

  pending(): readonly CodexApprovalRecord[] {
    return [...this.#records.values()];
  }

  register(params: {
    info: Omit<CodexExecutionApprovalRequestInfo, "interactionId">;
    rawId: number;
    anchorRowId: number | null;
    createdAt: number;
  }): CodexApprovalRecord {
    const interactionId = `codex-approval-${this.#ordinal++}`;
    const record: CodexApprovalRecord = {
      interactionId,
      rawId: params.rawId,
      info: { ...params.info, interactionId },
      anchorRowId: params.anchorRowId,
    };
    this.#records.set(interactionId, record);
    return record;
  }

  resolve(
    interactionId: string,
    decision: CodexExecutionApprovalDecision["decision"],
  ): CodexApprovalResolution | null {
    const record = this.#records.get(interactionId);
    if (!record) return null;
    this.#records.delete(interactionId);
    return {
      record,
      decision,
      codexResponse: { decision: decision === "approved" ? "approved" : "denied" },
    };
  }

  toPendingInteractions(createdAt: number): PendingInteraction[] {
    return this.pending().map((record) =>
      buildCodexApprovalInteraction({
        interactionId: record.interactionId,
        info: record.info,
        anchorRowId: record.anchorRowId,
        createdAt,
      }),
    );
  }
}
