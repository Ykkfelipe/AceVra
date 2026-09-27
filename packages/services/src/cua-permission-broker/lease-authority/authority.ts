import { randomUUID } from "node:crypto";

import type {
  ComputerUseObservationRecord,
  ComputerUseSessionRecord,
  ComputerUseTargetReport,
  LeaseAdmission,
  LeaseAuthority,
  LeaseRecord,
  LeaseTermination,
} from "./contract.js";

export interface LeaseAuthorityOptions {
  /** Releases the observed native Helper lease and resolves only after terminal cleanup. */
  releaseHelper?: (record: LeaseRecord) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const MAX_SESSIONS = 16;
const MAX_TEXT = 160;

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
export function createLeaseAuthority(options: LeaseAuthorityOptions = {}): LeaseAuthority {
  const now = options.now ?? Date.now;
  let current: LeaseRecord | undefined;
  let nextGeneration = 1;
  let operation: Promise<unknown> = Promise.resolve();
  let admission: LeaseAdmission = { paused: false };
  let lastTermination: LeaseTermination | undefined;
  // CUA-4：会话活动只是运行时上报的投影，按会话隔离并有上限，不能成为跨会话的共享事实。
  const sessions = new Map<string, ComputerUseSessionRecord>();

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
    if (!current || (current.state !== "reserving" && current.state !== "active")) return false;
    const stopping = { ...current, state: "stopped" as const };
    current = stopping;
    terminate(stopping, reason);
    if (stopping.helperLeaseId && options.releaseHelper) {
      await options.releaseHelper(stopping);
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
    }
  };

  return {
    beginAcquire: (owner) =>
      serial(() => {
        if (admission.paused) {
          throw Object.assign(new Error("Computer Use is paused"), { code: "paused" });
        }
        if (current && (current.state === "reserving" || current.state === "active")) {
          throw new Error("CUA lease already admitted");
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
    commitAcquire: (leaseId, helperLeaseId, helperRequirement) =>
      serial(() => {
        if (!current || current.leaseId !== leaseId || current.state !== "reserving") {
          throw new Error("CUA lease generation is no longer admissible");
        }
        current = { ...current, state: "active", helperLeaseId, helperRequirement };
        return current;
      }),
    release: (leaseId, reason) =>
      serial(() => {
        if (!current || current.leaseId !== leaseId) throw new Error("CUA lease is not active");
        if (current.state === "released" || current.state === "stopped") return current;
        current = { ...current, state: "released" };
        // 修复依据：此前 release 丢弃 reason，物理输入让出与正常释放无法区分，UI 无法如实提示。
        terminate(current, boundedText(reason) ?? "released");
        return current;
      }),
    stop: () =>
      serial(async () => {
        if (!current || current.state === "released" || current.state === "stopped") {
          return { status: "already_stopped" as const, record: current };
        }
        const stopping = { ...current, state: "stopped" as const };
        current = stopping;
        terminate(stopping, "stopped");
        if (stopping.helperLeaseId && options.releaseHelper) {
          await options.releaseHelper(stopping);
        }
        return { status: "released" as const, record: stopping };
      }),
    pause: () =>
      serial(async () => {
        if (admission.paused) return { status: "already_paused" as const, released: false };
        // 先关闭 admission 再释放：释放期间任何新的 begin_acquire 都必须被拒绝。
        admission = { paused: true, pausedAt: now() };
        const released = await endActiveLease("paused");
        return { status: "paused" as const, released };
      }),
    resume: () =>
      serial(() => {
        if (!admission.paused) return { status: "not_paused" as const };
        admission = { paused: false };
        return { status: "resumed" as const };
      }),
    getAdmission: () => admission,
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
    },
    getSession: (sessionId) => sessions.get(sessionId),
    getStatus: () => current,
    close: async () => {
      current = undefined;
      sessions.clear();
      await operation;
    },
  };
}
