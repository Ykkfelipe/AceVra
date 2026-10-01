import type {
  AccountDevice,
  ExecutionTarget,
  IRemoteProcessService,
  ProcessRequest,
  StartProcessResult,
  TaskEvent,
  TaskView,
} from "@zcode/shared";
import { LOCAL_TARGET_ID, type LocalProcessRunner } from "./localProcessRunner.js";

type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: Record<string, any> | null } | null>;

/** Remote task view → the shared TaskView (the control plane's `targetDeviceId` becomes targetId). */
const fromRemote = (task: Record<string, any>): TaskView => ({
  id: task.id,
  targetId: task.targetDeviceId,
  state: task.state,
  process: {
    executable: task.process.executable,
    args: task.process.args,
    cwd: task.process.cwd,
    timeoutMs: task.process.timeoutMs,
  },
  createdAt: task.createdAt,
  startedAt: task.startedAt,
  finishedAt: task.finishedAt,
  result: task.result,
  lastSequence: task.lastSequence,
});

/**
 * One entry point for "run a process on a target". Local runs never touch the control plane;
 * node runs go through the server-owned queue. Both return a handle at once and expose the
 * same TaskView/TaskEvent shape. Signed out → local still works, remote targets just aren't offered.
 */
export function createAccountTasks(deps: {
  local: LocalProcessRunner;
  call: Call;
  /** Whether the account is ready (remote targets only then). */
  accountReady: () => boolean;
  thisDevice: () => {
    id: string | null;
    displayName: string;
    capabilities: AccountDevice["capabilities"];
  };
}): IRemoteProcessService {
  const isLocal = (id: string) => id === LOCAL_TARGET_ID || id.startsWith("local-");
  return {
    async listTargets(): Promise<ExecutionTarget[]> {
      const me = deps.thisDevice();
      const targets: ExecutionTarget[] = [
        {
          id: LOCAL_TARGET_ID,
          type: "desktop",
          displayName: me.displayName,
          online: true,
          capabilities: me.capabilities,
          isThisDevice: true,
          available: true,
        },
      ];
      if (!deps.accountReady()) return targets;
      const result = await deps.call("GET", "/v1/targets");
      for (const t of (result?.status === 200 ? (result.json?.targets ?? []) : []) as Record<
        string,
        any
      >[]) {
        if (t.id === me.id) continue; // this desktop is the local target above
        targets.push({
          id: t.id,
          type: t.type,
          displayName: t.displayName,
          online: t.online,
          capabilities: t.capabilities,
          isThisDevice: false,
          available: t.available,
          ...(t.unavailableReason ? { unavailableReason: t.unavailableReason } : {}),
        });
      }
      return targets;
    },
    async startRemoteProcess(input): Promise<StartProcessResult> {
      if (isLocal(input.targetId)) {
        const started = deps.local.start(input.process);
        return started.ok
          ? { ok: true, taskId: started.taskId, targetId: LOCAL_TARGET_ID }
          : { ok: false, reason: "invalid_request" };
      }
      if (!deps.accountReady()) return { ok: false, reason: "not_signed_in" };
      const result = await deps.call("POST", "/v1/tasks", {
        targetDeviceId: input.targetId,
        process: toWire(input.process),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      if (!result) return { ok: false, reason: "unavailable" };
      if (result.status === 201 || result.status === 200)
        return { ok: true, taskId: result.json!.task.id, targetId: input.targetId };
      if (result.status === 400) return { ok: false, reason: "invalid_request" };
      return {
        ok: false,
        reason:
          result.status === 404
            ? "target_not_found"
            : result.status === 409
              ? "target_unavailable"
              : "unavailable",
      };
    },
    async listTasks(): Promise<TaskView[]> {
      const local = deps.local.list();
      if (!deps.accountReady()) return local;
      const result = await deps.call("GET", "/v1/tasks?limit=25");
      const remote =
        result?.status === 200
          ? ((result.json?.tasks ?? []) as Record<string, any>[]).map(fromRemote)
          : [];
      return [...local, ...remote].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getTaskEvents(taskId: string, after: number): Promise<TaskEvent[]> {
      if (isLocal(taskId)) return deps.local.events(taskId, after) ?? [];
      const result = await deps.call(
        "GET",
        `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${Math.max(0, Math.floor(after))}`,
      );
      return result?.status === 200 ? (result.json?.events as TaskEvent[]) : [];
    },
    async cancelTask(taskId: string, force = false): Promise<TaskView | null> {
      if (isLocal(taskId)) return deps.local.cancel(taskId);
      const result = await deps.call("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
        force,
      });
      return result?.status === 200 ? fromRemote(result.json!.task) : null;
    },
  };
}

const toWire = (p: ProcessRequest) => ({
  executable: p.executable,
  args: p.args ?? [],
  cwd: p.cwd,
  env: p.env ?? {},
  ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}),
});
