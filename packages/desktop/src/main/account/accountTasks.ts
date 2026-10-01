import type {
  AccountDevice,
  ExecutionTarget,
  IRemoteProcessService,
  ProcessRequest,
  StartProcessResult,
  TaskEvent,
  TaskView,
} from "@zcode/shared";
import { SSH_TARGET_PREFIX } from "@zcode/shared";
import { LOCAL_TARGET_ID, type LocalProcessRunner } from "./localProcessRunner.js";
import { SSH_TASK_PREFIX, type SshProcessRunner } from "../computers/sshProcessRunner.js";
import { computerIdOf } from "../computers/computerJob.js";

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

/** Main-side tasks API: the shared contract plus a single-task read for the agent wait loop. */
export interface AccountTasksApi extends IRemoteProcessService {
  getTask(taskId: string): Promise<TaskView | null>;
}

const UNAVAILABLE_DETAILS = new Set([
  "target_offline",
  "target_revoked",
  "target_not_node",
  "target_lacks_shell",
]);

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
  /** SSH computers: local config, no account needed (acevra-agent-computer.md). */
  ssh?: {
    listTargets(): Promise<ExecutionTarget[]>;
    hostAliasFor(targetId: string): Promise<string | null>;
    runner: SshProcessRunner;
    /** 真实事件推进 Computer pane 活动行（spec §3.3），如终端命令启动。 */
    noteActivity?(computerId: string, action: string): void;
  };
}): AccountTasksApi {
  const isLocal = (id: string) => id === LOCAL_TARGET_ID || id.startsWith("local-");
  const isSshTask = (id: string) => id.startsWith(SSH_TASK_PREFIX);
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
      if (deps.ssh) targets.push(...(await deps.ssh.listTargets().catch(() => [])));
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
      if (input.targetId.startsWith(SSH_TARGET_PREFIX)) {
        const hostAlias = deps.ssh ? await deps.ssh.hostAliasFor(input.targetId) : null;
        if (!deps.ssh || !hostAlias) return { ok: false, reason: "target_not_found" };
        const started = deps.ssh.runner.start({
          targetId: input.targetId,
          hostAlias,
          process: input.process,
        });
        // 活动行只报告真实事件：终端任务真的启动了才显示（spec §3.3，不做周期性“仍在工作”文本）。
        const computerId = computerIdOf(input.targetId);
        if (computerId) deps.ssh.noteActivity?.(computerId, "terminal");
        return { ok: true, taskId: started.taskId, targetId: input.targetId };
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
      if (result.status === 404) return { ok: false, reason: "target_not_found" };
      if (result.status === 409) {
        // M2F：保留控制面 409 的真实原因（离线/吊销/无 shell），agent 才能如实告知用户，
        // 不能笼统成 "unavailable" 后被误读为可以改在本机执行。
        const detail = result.json?.error;
        return {
          ok: false,
          reason: "target_unavailable",
          ...(typeof detail === "string" && UNAVAILABLE_DETAILS.has(detail) ? { detail } : {}),
        };
      }
      return { ok: false, reason: "unavailable" };
    },
    async getTask(taskId: string): Promise<TaskView | null> {
      if (isLocal(taskId)) return deps.local.list().find((task) => task.id === taskId) ?? null;
      if (isSshTask(taskId)) return deps.ssh?.runner.get(taskId) ?? null;
      if (!deps.accountReady()) return null;
      const result = await deps.call("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
      return result?.status === 200 && result.json?.task ? fromRemote(result.json.task) : null;
    },
    async listTasks(): Promise<TaskView[]> {
      const local = [...deps.local.list(), ...(deps.ssh?.runner.list() ?? [])];
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
      if (isSshTask(taskId)) return deps.ssh?.runner.events(taskId, after) ?? [];
      const result = await deps.call(
        "GET",
        `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${Math.max(0, Math.floor(after))}`,
      );
      return result?.status === 200 ? (result.json?.events as TaskEvent[]) : [];
    },
    async cancelTask(taskId: string, force = false): Promise<TaskView | null> {
      if (isLocal(taskId)) return deps.local.cancel(taskId);
      if (isSshTask(taskId)) return deps.ssh?.runner.cancel(taskId) ?? null;
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
