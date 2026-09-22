// Codex 审批登记表（domain，纯函数类）。
// 审批请求必须先落表并经 pendingInteraction 下发到 harness，才允许把决定发回 Codex；
// 未知的 interactionId 一律拒绝（resolve 返回 null），静默放行是安全红线。
//
// 应答形状严格来自已安装 Codex 的 App Server JSON Schema（0.155.0-alpha.9.2）：
// - CommandExecution/FileChange 的 Response = { decision: "accept" | "acceptForSession" |
//   "decline" | "cancel" | …amendment 变体 }。本后端只会发 "accept"/"decline"：
//   decline = 拒绝该次执行但 turn 继续；cancel 会打断整轮，不属于普通否决语义；
//   acceptForSession 会让同类操作本轮免审，削弱 fail-closed 姿态，同样不使用。
// - item/permissions/requestApproval 的 Response 没有 decision 字段，而是
//   { permissions: GrantedPermissionProfile, scope?: "turn" | "session" }。拒绝 =
//   空 profile（不授予任何额外权限）；批准 = 原样回传请求里的 permissions profile。
//   请求中的 profile 只留在宿主内存记录里，绝不下发通道。
import type { CodexExecutionApprovalDecision, CodexExecutionApprovalRequestInfo } from "@zcode/shared";
import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { buildCodexApprovalInteraction } from "./codexSnapshot.js";

export interface CodexApprovalRecord {
  readonly interactionId: string;
  readonly rawId: number;
  readonly info: CodexExecutionApprovalRequestInfo;
  readonly anchorRowId: number | null;
  /** item/permissions/requestApproval 请求的权限 profile（Codex 本机形状，仅宿主内存）。 */
  readonly requestedPermissions?: unknown;
}

export interface CodexApprovalResolution {
  readonly record: CodexApprovalRecord;
  readonly decision: CodexExecutionApprovalDecision["decision"];
  readonly codexResponse: Record<string, unknown>;
}

/** 审批应答的 schema 真形映射；decision 只映射到 accept/decline（见文件头）。 */
export function codexApprovalWireResponse(params: {
  decision: CodexExecutionApprovalDecision["decision"];
  kind: CodexExecutionApprovalRequestInfo["kind"];
  requestedPermissions?: unknown;
}): Record<string, unknown> {
  if (params.kind === "permissions") {
    if (params.decision !== "approved") return { permissions: {}, scope: "turn" };
    // 批准：回传请求方声明的 profile；解析不出（异常形状）时保持空授权，绝不发明权限。
    const requested =
      typeof params.requestedPermissions === "object" && params.requestedPermissions !== null
        ? params.requestedPermissions
        : {};
    return { permissions: requested, scope: "turn" };
  }
  return { decision: params.decision === "approved" ? "accept" : "decline" };
}

/**
 * 无法路由到 runtime 的审批请求的兜底应答（fail closed）：权限类按 schema 回空授权，
 * 其余回 decline。绝不允许静默丢弃（turn 会挂死）也不允许放行。
 */
export function codexUnroutableApprovalResponse(method: string): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  return { decision: "decline" };
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
    requestedPermissions?: unknown;
  }): CodexApprovalRecord {
    const interactionId = `codex-approval-${this.#ordinal++}`;
    const record: CodexApprovalRecord = {
      interactionId,
      rawId: params.rawId,
      info: { ...params.info, interactionId },
      anchorRowId: params.anchorRowId,
      ...(params.requestedPermissions !== undefined
        ? { requestedPermissions: params.requestedPermissions }
        : {}),
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
      codexResponse: codexApprovalWireResponse({
        decision,
        kind: record.info.kind,
        requestedPermissions: record.requestedPermissions,
      }),
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
