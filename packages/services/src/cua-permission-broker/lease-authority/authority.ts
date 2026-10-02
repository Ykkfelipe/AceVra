import { randomUUID } from "node:crypto";

import {
  createWorkspaceProjection,
  type WorkspaceProjection,
} from "@zcode/zcode-cua/computer-workspace-projection";

import type {
  ComputerUseObservationRecord,
  ComputerUseSessionRecord,
  ComputerUseTargetReport,
  LeaseAdmission,
  LeaseAuthority,
  LeaseRecord,
  LeaseTermination,
} from "./contract.js";
import type { ComputerUseWorkspaceSnapshot, WorkspaceProjectionReader } from "./workspace.js";
import { createTakeoverGrants, isUserReclaimReason } from "./takeover.js";

const coded = (message: string, code: string) => Object.assign(new Error(message), { code }); // Phase 2

export interface LeaseAuthorityOptions {
  /** Releases the observed native Helper lease and resolves only after terminal cleanup. */
  releaseHelper?: (record: LeaseRecord) => Promise<void>;
  /** Relaunch the Helper through its lifecycle owner (bounded, single-flight, same credentials). */
  recoverHelper?: () => Promise<{ connected: boolean; connectionGeneration?: number }>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const MAX_SESSIONS = 16;
const MAX_TEXT = 160;

/**
 * M3：宿主侧维护的 mini Computer 投影只跟踪 workspace 面向的方法（observe 建立帧，
 * workspace_* 是后台动作）。原生前台动作仍由既有 bar 投影表达，不混入 workspace 视图。
 */
// press / set_value 是后台语义动作：运行时从最近一次 observe 的树解析出目标 pid 与元素中心，
// 与 workspace_* 一样驱动本地预览的目标窗口与逻辑光标（不再只有 workspace_* 才有光标）。
const WORKSPACE_PROJECTED_METHODS = new Set([
  "observe",
  "workspace_click",
  "workspace_type_text",
  "workspace_scroll",
  "press",
  "set_value",
]);
const SEMANTIC_UPDATE_ONLY_METHODS = new Set(["press", "set_value"]);

function workspaceTargetOf(
  target: ComputerUseTargetReport | undefined,
): { pid: number; windowId: number | null; appName: string | null } | undefined {
  const pid = finiteNumber(target?.pid);
  if (pid === undefined) return undefined;
  return {
    pid,
    windowId: finiteNumber(target?.windowId) ?? null,
    appName: boundedText(target?.app) ?? null,
  };
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeTarget(
  value: ComputerUseTargetReport | undefined,
): ComputerUseTargetReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const target: ComputerUseTargetReport = {
    ...(finiteNumber(value.pid) !== undefined ? { pid: value.pid } : {}),
    ...(finiteNumber(value.windowId) !== undefined ? { windowId: value.windowId } : {}),
    ...(boundedText(value.app) ? { app: boundedText(value.app) } : {}),
    ...(boundedText(value.bundleId) ? { bundleId: boundedText(value.bundleId) } : {}),
    ...(boundedText(value.window) ? { window: boundedText(value.window) } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

/** Single service-owned serial authority. Runtime maps remain projections only. */
export function createLeaseAuthority(
  options: LeaseAuthorityOptions = {},
): LeaseAuthority & WorkspaceProjectionReader {
  const now = options.now ?? Date.now;
  let current: LeaseRecord | undefined;
  let nextGeneration = 1;
  let operation: Promise<unknown> = Promise.resolve();
  let admission: LeaseAdmission = { paused: false };
  let lastTermination: LeaseTermination | undefined;
  // CUA-4：会话活动只是运行时上报的投影，按会话隔离并有上限，不能成为跨会话的共享事实。
  const sessions = new Map<string, ComputerUseSessionRecord>();
  // M3：mini Computer 视图的宿主持有投影，与会话记录同生命周期、同上限。
  const workspaces = new Map<string, WorkspaceProjection>();
  // 屏幕接管授权：只有拥有会话的 UI 能批准；接管被用户打断/停止/暂停时撤销。
  const takeover = createTakeoverGrants(now);

  const workspaceFor = (sessionId: string): WorkspaceProjection => {
    let workspace = workspaces.get(sessionId);
    if (!workspace) {
      workspace = createWorkspaceProjection({
        workspaceId: `workspace:${sessionId}`,
        sessionId,
      });
      workspaces.set(sessionId, workspace);
    }
    return workspace;
  };

  const serial = <T>(task: () => T | Promise<T>): Promise<T> => {
    const result = operation.then(task, task);
    operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const terminate = (record: LeaseRecord, reason: string) => {
    lastTermination = { leaseId: record.leaseId, reason, at: now() };
  };

  const endActiveLease = async (reason: string): Promise<boolean> => {
    takeover.revoke();
    if (!current || (current.state !== "reserving" && current.state !== "active")) return false;
    const stopping = { ...current, state: "stopped" as const };
    current = stopping;
    terminate(stopping, reason);
    if (stopping.helperLeaseId && options.releaseHelper) {
      await options.releaseHelper(stopping).catch(() => undefined); // 不可达也如实暂停
    }
    return true;
  };

  const storeSession = (record: ComputerUseSessionRecord) => {
    sessions.delete(record.sessionId);
    sessions.set(record.sessionId, record);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
      workspaces.delete(oldest);
    }
  };

  return {
    beginAcquire: (owner) =>
      serial(() => {
        if (admission.paused) {
          throw Object.assign(new Error("Computer Use is paused"), { code: "paused" });
        }
        if (current && (current.state === "reserving" || current.state === "active")) {
          throw coded("CUA lease already admitted", "exclusive_busy");
        }
        current = {
          leaseId: randomUUID(),
          ownerSession: owner.session,
          ownerTask: owner.task,
          generation: nextGeneration++,
          state: "reserving",
        };
        return current;
      }),
    commitAcquire: (leaseId, helperLeaseId, helperRequirement, helperConnectionGeneration) =>
      serial(() => {
        if (!current || current.leaseId !== leaseId || current.state !== "reserving") {
          throw coded("CUA lease generation is no longer admissible", "lease_not_owned");
        }
        current = { ...current, state: "active", helperLeaseId, helperRequirement };
        if (helperConnectionGeneration !== undefined)
          current = { ...current, helperConnectionGeneration };
        return current;
      }),
    release: (leaseId, reason) =>
      serial(() => {
        if (!current || current.leaseId !== leaseId)
          throw coded("CUA lease is not active", "invalid_lease");
        if (current.state === "released" || current.state === "stopped") return current;
        current = { ...current, state: "released" };
        if (isUserReclaimReason(reason)) takeover.revoke(current.ownerSession); // 租约到期等保留授权
        // 修复依据：此前 release 丢弃 reason，物理输入让出与正常释放无法区分，UI 无法如实提示。
        terminate(current, boundedText(reason) ?? "released");
        return current;
      }),
    stop: (stopOptions) =>
      serial(async () => {
        if (!current || current.state === "released" || current.state === "stopped") {
          return { status: "already_stopped" as const, record: current };
        }
        // Phase 5：Stop 先作废授权，并发的运行时重新获取只会读到"无授权"。修复依据（9eb4f148 实测）：
        // sideband stop 只清理运行时预留，不撤销用户的 Allow；只有 Stop/Pause/打断撤销。
        if (stopOptions?.keepTakeover !== true) takeover.revoke();
        const stopping = { ...current, state: "stopped" as const };
        current = stopping;
        terminate(stopping, "stopped");
        if (stopping.helperLeaseId && options.releaseHelper) {
          // Helper 不可达时 Stop 仍如实生效（安全不变量：AceVra 故障 → 用户拿回控制）。
          const helperRelease = await options.releaseHelper(stopping).then(
            () => "confirmed" as const,
            () => "unreachable" as const,
          );
          return { status: "released" as const, record: stopping, helperRelease };
        }
        return { status: "released" as const, record: stopping };
      }),
    pause: () =>
      serial(async () => {
        if (admission.paused) return { status: "already_paused" as const, released: false };
        // 先关闭 admission 再释放：释放期间任何新的 begin_acquire 都必须被拒绝。
        admission = { paused: true, pausedAt: now() };
        // M3：暂停是真实边界，workspace 投影同步进入 paused，mini Computer 视图如实呈现。
        for (const workspace of workspaces.values()) workspace.notePaused(true);
        const released = await endActiveLease("paused");
        return { status: "paused" as const, released };
      }),
    resume: () =>
      serial(() => {
        if (!admission.paused) return { status: "not_paused" as const };
        admission = { paused: false };
        for (const workspace of workspaces.values()) workspace.notePaused(false);
        return { status: "resumed" as const };
      }),
    getAdmission: () => admission,
    // revoke 只属于 authority 自身（打断/停止/暂停）：对外端口不暴露它。
    takeover: {
      request: (owner) => takeover.request(owner),
      status: (owner) => takeover.status(owner),
      decide: (session, decision) => takeover.decide(session, decision),
      view: (session) => takeover.view(session),
      grant: (owner) => takeover.grant(owner),
    },
    getLastTermination: () => lastTermination,
    reportActivity: (report) => {
      const sessionId = boundedText(report?.session);
      const method = boundedText(report?.method);
      const callId = boundedText(report?.callId);
      const at = finiteNumber(report?.at);
      if (!sessionId || !method || !callId || at === undefined) return;
      if (report.phase !== "started" && report.phase !== "completed") return;
      const previous = sessions.get(sessionId);
      const last = previous?.activity;
      // 两次上报走独立连接可能乱序：同一调用的 started 不能覆盖已完成结果，旧调用也不能覆盖新调用。
      if (last) {
        if (last.callId === callId && last.phase === "completed" && report.phase === "started")
          return;
        if (last.callId !== callId && at < (last.completedAt ?? last.startedAt)) return;
      }
      const startedAt = last?.callId === callId ? last.startedAt : at;
      const activity = {
        callId,
        task: boundedText(report.task) ?? "",
        method,
        phase: report.phase,
        startedAt,
        ...(report.phase === "completed" ? { completedAt: at } : {}),
        ...(boundedText(report.effect) ? { effect: boundedText(report.effect) } : {}),
        ...(boundedText(report.route) ? { route: boundedText(report.route) } : {}),
        ...(boundedText(report.code) ? { code: boundedText(report.code) } : {}),
        ...(boundedText(report.inputDelivery)
          ? { inputDelivery: boundedText(report.inputDelivery) }
          : {}),
        ...(boundedText(report.applicationEffect)
          ? { applicationEffect: boundedText(report.applicationEffect) }
          : {}),
      };
      let observation: ComputerUseObservationRecord | undefined = previous?.observation;
      const reported = report.phase === "completed" ? report.observation : undefined;
      const observationId = boundedText(reported?.id);
      if (reported && observationId) {
        const target = sanitizeTarget(report.target);
        observation = {
          id: observationId,
          capturedAt: at,
          ...(finiteNumber(reported.width) !== undefined ? { width: reported.width } : {}),
          ...(finiteNumber(reported.height) !== undefined ? { height: reported.height } : {}),
          ...(typeof reported.blank === "boolean" ? { blank: reported.blank } : {}),
          ...(target ? { target } : {}),
          ...(typeof reported.framePath === "string" && reported.framePath
            ? { framePath: reported.framePath }
            : {}),
        };
      }
      storeSession({
        sessionId,
        activity,
        ...(observation ? { observation } : {}),
      });
      // M3：用同一份被接受的上报喂 mini Computer 投影（顺序、上限、乱序丢弃与活动记录
      // 完全一致，不引入第二条事实来源）。投影只增改自身状态，绝不触发任何捕获。
      // 语义动作只更新已存在的 workspace（其 semantic_ref 必来自先前的 observe），绝不凭空创建视图。
      const semanticOnly = SEMANTIC_UPDATE_ONLY_METHODS.has(method) && !workspaces.has(sessionId);
      if (WORKSPACE_PROJECTED_METHODS.has(method) && !semanticOnly) {
        const workspace = workspaceFor(sessionId);
        const target = workspaceTargetOf(report.target);
        if (report.phase === "started") {
          workspace.noteActionStart({ method, ...(target ? { target } : {}) });
        } else if (report.observation) {
          workspace.noteObservation({
            ...(target ? { target } : {}),
            result: {
              image: {
                observation_id: report.observation.id,
                ...(finiteNumber(report.observation.width) !== undefined
                  ? { width: report.observation.width }
                  : {}),
                ...(finiteNumber(report.observation.height) !== undefined
                  ? { height: report.observation.height }
                  : {}),
              },
            },
          });
        } else {
          const cursor = report.workspaceCursor;
          const cursorX = finiteNumber(cursor?.x);
          const cursorY = finiteNumber(cursor?.y);
          workspace.noteActionResult({
            method,
            ...(target ? { target } : {}),
            result: {
              ...(boundedText(report.effect) ? { effect: boundedText(report.effect) } : {}),
              ...(boundedText(report.code) ? { code: boundedText(report.code) } : {}),
            },
            ...(cursorX !== undefined && cursorY !== undefined
              ? { cursor: { x: cursorX, y: cursorY } }
              : {}),
          });
        }
      }
    },
    getSession: (sessionId) => sessions.get(sessionId),
    // 纯读：显式映射成对外快照；重复读取不改变任何状态、不触发捕获，宿主内部的
    // 零偷取证据等字段绝不跨界。
    getWorkspace: (sessionId): ComputerUseWorkspaceSnapshot | undefined => {
      const workspace = workspaces.get(sessionId);
      if (!workspace) return undefined;
      const snap = workspace.snapshot();
      return {
        workspaceId: snap.workspaceId,
        backendId: snap.backendId,
        state: snap.state,
        ...(snap.target
          ? {
              target: {
                pid: snap.target.pid,
                windowId: snap.target.windowId,
                appName: snap.target.appName,
              },
            }
          : {}),
        ...(snap.frame
          ? {
              frame: {
                frameId: snap.frame.frameId,
                capturedAt: snap.frame.capturedAt,
                freshness: snap.frame.freshness,
                dimensions: snap.frame.dimensions,
              },
            }
          : {}),
        ...(snap.cursor
          ? {
              cursor: {
                x: snap.cursor.x,
                y: snap.cursor.y,
                updatedAt: snap.cursor.updatedAt,
              },
            }
          : {}),
        ...(snap.action
          ? {
              action: {
                method: snap.action.method,
                label: snap.action.label,
                targetLabel: snap.action.targetLabel,
                startedAt: snap.action.startedAt,
                completedAt: snap.action.completedAt,
                effect: snap.action.effect,
                code: snap.action.code,
              },
            }
          : {}),
        framesCaptured: snap.framesCaptured,
        updatedAt: snap.updatedAt,
      };
    },
    getStatus: () => current,
    close: async () => {
      current = undefined;
      sessions.clear();
      workspaces.clear();
      await operation;
    },
  };
}
