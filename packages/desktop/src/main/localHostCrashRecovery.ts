/**
 * Local Host crash recovery policy (specs/desktop-host-unification.md "Local Host crash recovery").
 *
 * Pure decision logic owned by the window lifecycle: it never spawns anything itself. The
 * lifecycle asks it what to do when its Local Host exits and performs the restart through the
 * existing renderer reload → dom-ready → spawn path.
 */

export interface LocalHostExitFacts {
  /** App force-quit, or the host was being disposed on purpose (reload, window close). */
  intentional: boolean;
  /** The owning BrowserWindow still exists. */
  windowAlive: boolean;
  /** The exiting host is still the window's current host generation. */
  isCurrent: boolean;
}

export type LocalHostExitDecision =
  | { action: "ignore"; reason: "intentional" | "window_closed" | "superseded" }
  | { action: "restart"; attempt: number; delayMs: number }
  | { action: "give_up"; attempts: number };

export const LOCAL_HOST_RESTART_BACKOFF_MS = Object.freeze([500, 2_000, 8_000]);
export const LOCAL_HOST_RESTART_WINDOW_MS = 120_000;

export function createLocalHostCrashRecovery(
  options: {
    backoffMs?: readonly number[];
    windowMs?: number;
    now?: () => number;
  } = {},
) {
  const backoffMs = options.backoffMs ?? LOCAL_HOST_RESTART_BACKOFF_MS;
  const windowMs = options.windowMs ?? LOCAL_HOST_RESTART_WINDOW_MS;
  const now = options.now ?? Date.now;
  let crashes: number[] = [];
  return {
    decide(facts: LocalHostExitFacts): LocalHostExitDecision {
      if (facts.intentional) return { action: "ignore", reason: "intentional" };
      if (!facts.windowAlive) return { action: "ignore", reason: "window_closed" };
      if (!facts.isCurrent) return { action: "ignore", reason: "superseded" };
      const at = now();
      // 只统计窗口期内的崩溃：偶发崩溃后长期稳定运行不应耗尽预算。
      crashes = crashes.filter((time) => at - time < windowMs);
      if (crashes.length >= backoffMs.length) {
        return { action: "give_up", attempts: crashes.length };
      }
      crashes.push(at);
      const attempt = crashes.length;
      return { action: "restart", attempt, delayMs: backoffMs[attempt - 1] ?? 0 };
    },
    /** Explicit user retry (e.g. "Reload" after exhaustion) starts a fresh budget. */
    reset(): void {
      crashes = [];
    },
  };
}

/** The part of a utility process the supervisor needs (Electron's UtilityProcess satisfies it). */
export interface SupervisedHost {
  once(event: "exit", listener: (code: number) => void): unknown;
}

/**
 * Per-window Local Host supervisor: tracks the current host generation, observes exits and
 * schedules recovery through the caller's restart path. Electron-free so it is testable.
 */
export function createLocalHostSupervisor<Host extends SupervisedHost>(deps: {
  policy?: ReturnType<typeof createLocalHostCrashRecovery>;
  isIntentional: (host: Host) => boolean;
  isWindowAlive: () => boolean;
  /** Restart through the existing path (renderer reload → dom-ready → spawn). */
  recover: (reason: string) => void;
  onExhausted?: (retry: () => void) => void;
  log?: (message: string) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}) {
  const policy = deps.policy ?? createLocalHostCrashRecovery();
  const schedule = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let generation = 0;
  let current: Host | null = null;
  let pending: unknown = null;
  const clearPending = () => {
    if (pending !== null) cancel(pending);
    pending = null;
  };
  return {
    get generation(): number {
      return generation;
    },
    get current(): Host | null {
      return current;
    },
    /** A new Local Host became the window's host. */
    adopt(host: Host): number {
      clearPending();
      current = host;
      const adopted = ++generation;
      host.once("exit", (code) => {
        const decision = policy.decide({
          intentional: deps.isIntentional(host),
          windowAlive: deps.isWindowAlive(),
          isCurrent: current === host && adopted === generation,
        });
        if (current === host) current = null;
        if (decision.action === "ignore") return;
        if (decision.action === "give_up") {
          deps.log?.(`Local Host crashed ${decision.attempts} times; not restarting`);
          deps.onExhausted?.(() => {
            policy.reset();
            deps.recover("user retry after exhausted restarts");
          });
          return;
        }
        deps.log?.(
          `Local Host exited unexpectedly (code ${code}); restart ${decision.attempt} in ${decision.delayMs}ms`,
        );
        clearPending();
        pending = schedule(() => {
          pending = null;
          // 延迟期间若已有新 host（例如用户手动刷新），旧崩溃不再触发重启。
          if (current !== null || adopted !== generation || !deps.isWindowAlive()) return;
          deps.recover(`crash restart ${decision.attempt}`);
        }, decision.delayMs);
      });
      return adopted;
    },
    dispose(): void {
      clearPending();
    },
  };
}

/**
 * render-process-gone reasons that mean the primary renderer died abnormally and a reload can
 * restore it (specs/desktop-host-unification.md "Renderer crash recovery and host stdio").
 * `clean-exit` is deliberate; `launch-failed` / `integrity-failure` would only loop.
 */
const RECOVERABLE_RENDERER_GONE_REASONS = new Set([
  "crashed",
  "killed",
  "oom",
  "abnormal-exit",
  "memory-eviction",
]);

export function isRecoverableRendererGoneReason(reason: string): boolean {
  return RECOVERABLE_RENDERER_GONE_REASONS.has(reason);
}

/**
 * Primary-window renderer recovery. 修复依据（2026-10-02 实测）：外部 kill 掉 renderer 后 Main
 * 只记录 render-process-gone，窗口沦为空壳而 host/Agent/Helper 继续运行。与 Local Host 同一
 * 所有者、同一有界策略；恢复手段是 reload，dom-ready 经既有 AttachServicePort 重新挂上存活的
 * host，会话不受影响。Electron-free so it is testable.
 */
export function createRendererCrashSupervisor(deps: {
  policy?: ReturnType<typeof createLocalHostCrashRecovery>;
  isForceQuitting: () => boolean;
  isWindowAlive: () => boolean;
  reload: () => void;
  log?: (message: string) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}) {
  const policy = deps.policy ?? createLocalHostCrashRecovery();
  const schedule = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let pending: unknown = null;
  return {
    onRendererGone(reason: string): void {
      const decision = policy.decide({
        intentional: deps.isForceQuitting() || !isRecoverableRendererGoneReason(reason),
        windowAlive: deps.isWindowAlive(),
        isCurrent: true,
      });
      if (decision.action === "ignore") return;
      if (decision.action === "give_up") {
        deps.log?.(`renderer gone (${reason}) ${decision.attempts} times; not reloading`);
        return;
      }
      deps.log?.(`renderer gone (${reason}); reload ${decision.attempt} in ${decision.delayMs}ms`);
      if (pending !== null) cancel(pending);
      pending = schedule(() => {
        pending = null;
        if (!deps.isWindowAlive() || deps.isForceQuitting()) return;
        deps.reload();
      }, decision.delayMs);
    },
    dispose(): void {
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}
