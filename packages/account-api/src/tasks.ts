/* eslint-disable max-lines -- 任务队列的状态迁移（create/dispatch/accept/event/finish/sync/sweep）共享同一组事务辅助函数，拆文件会割裂状态机。 */
import { randomUUID } from "node:crypto";
import type { ProcessSpec } from "./processSpec.js";
import type { SqlExecutor } from "./ports.js";
import type { FailReason, NodeEventType, TaskResult } from "./taskProtocol.js";

export type TaskState =
  | "queued"
  | "dispatching"
  | "running"
  | "running_unknown"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";
const TERMINAL: readonly TaskState[] = ["completed", "failed", "cancelled"];
const MAX_OFFER_ATTEMPTS = 3;

interface TaskRow {
  id: string;
  account_id: string;
  target_device_id: string;
  created_by: string;
  type: "process";
  state: TaskState;
  spec: ProcessSpec;
  attempt: number;
  result: Record<string, unknown> | null;
  output_bytes: number;
  next_seq: number;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  assigned_at: Date | string | null;
}
const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

export interface TaskView {
  id: string;
  targetDeviceId: string;
  type: "process";
  state: TaskState;
  attempt: number;
  process: {
    executable: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    envNames: string[];
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
  lastSequence: number;
}
export interface TaskEventView {
  sequence: number;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

/** Env values may be sensitive: views expose names only. */
export function toTaskView(row: TaskRow): TaskView {
  return {
    id: row.id,
    targetDeviceId: row.target_device_id,
    type: row.type,
    state: row.state,
    attempt: row.attempt,
    process: {
      executable: row.spec.executable,
      args: row.spec.args,
      cwd: row.spec.cwd,
      timeoutMs: row.spec.timeoutMs,
      envNames: Object.keys(row.spec.env),
    },
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    result: row.result,
    lastSequence: row.next_seq,
  };
}

export interface TaskServiceOptions {
  isLive?: (deviceId: string) => boolean;
  nodeGraceMs?: number;
  /** Queued longer than this without a taker → failed(queue_expired). */
  queueTtlMs?: number;
  /** An offer unacknowledged this long goes back to the queue. */
  offerTimeoutMs?: number;
  /** Stored output cap per task (control-plane backstop; the node enforces its own). */
  maxOutputBytes?: number;
}

export type CreateTaskResult =
  | { ok: true; created: boolean; task: TaskView }
  | {
      ok: false;
      reason:
        | "target_not_found"
        | "target_revoked"
        | "target_not_node"
        | "target_lacks_shell"
        | "target_offline";
    };

export function createTaskService(
  db: SqlExecutor,
  clock: () => number = Date.now,
  opts: TaskServiceOptions = {},
) {
  const o = { queueTtlMs: 5 * 60_000, offerTimeoutMs: 15_000, maxOutputBytes: 1 << 20, ...opts };
  const now = () => new Date(clock());

  /** Allocates the next ordered sequence; node re-sends dedupe on source_seq. Caller holds the row lock. */
  async function appendEvent(
    tx: SqlExecutor,
    taskId: string,
    type: string,
    payload: Record<string, unknown> = {},
    sourceSeq?: number,
  ): Promise<boolean> {
    if (sourceSeq !== undefined) {
      const dup = await tx.query(
        "SELECT 1 FROM task_events WHERE task_id = $1 AND source_seq = $2",
        [taskId, sourceSeq],
      );
      if (dup.rows.length) return false;
    }
    const seq = await tx.query<{ next_seq: number }>(
      "UPDATE tasks SET next_seq = next_seq + 1, updated_at = $2 WHERE id = $1 RETURNING next_seq",
      [taskId, now()],
    );
    await tx.query(
      "INSERT INTO task_events (task_id, sequence, type, ts, payload, source_seq) VALUES ($1,$2,$3,$4,$5,$6)",
      [taskId, seq.rows[0]!.next_seq, type, now(), JSON.stringify(payload), sourceSeq ?? null],
    );
    return true;
  }
  const lock = async (tx: SqlExecutor, id: string, deviceId?: string) => {
    const rows = await tx.query<TaskRow>(
      deviceId === undefined
        ? "SELECT * FROM tasks WHERE id = $1 FOR UPDATE"
        : "SELECT * FROM tasks WHERE id = $1 AND target_device_id = $2 FOR UPDATE",
      deviceId === undefined ? [id] : [id, deviceId],
    );
    return rows.rows[0] ?? null;
  };
  const setState = (
    tx: SqlExecutor,
    id: string,
    state: TaskState,
    extra: { result?: unknown; finished?: boolean; started?: boolean } = {},
  ) =>
    tx.query(
      `UPDATE tasks SET state = $2, updated_at = $3,
         result = COALESCE($4::jsonb, result),
         finished_at = CASE WHEN $5 THEN $3 ELSE finished_at END,
         started_at = CASE WHEN $6 AND started_at IS NULL THEN $3 ELSE started_at END
       WHERE id = $1`,
      [
        id,
        state,
        now(),
        extra.result === undefined ? null : JSON.stringify(extra.result),
        extra.finished === true,
        extra.started === true,
      ],
    );
  const reload = async (tx: SqlExecutor, id: string) =>
    (await tx.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id])).rows[0]!;

  return {
    async create(
      accountId: string,
      createdBy: string,
      input: { targetDeviceId: string; spec: ProcessSpec; idempotencyKey?: string },
    ): Promise<CreateTaskResult> {
      return db.transaction(async (tx) => {
        if (input.idempotencyKey) {
          const existing = await tx.query<TaskRow>(
            "SELECT * FROM tasks WHERE account_id = $1 AND idempotency_key = $2",
            [accountId, input.idempotencyKey],
          );
          if (existing.rows[0])
            return { ok: true, created: false, task: toTaskView(existing.rows[0]) };
        }
        const device = (
          await tx.query<{
            revoked_at: Date | string | null;
            type: string;
            capabilities: string[];
            id: string;
          }>("SELECT * FROM devices WHERE id = $1 AND account_id = $2", [
            input.targetDeviceId,
            accountId,
          ])
        ).rows[0];
        if (!device) return { ok: false, reason: "target_not_found" };
        if (device.revoked_at) return { ok: false, reason: "target_revoked" };
        if (device.type !== "node") return { ok: false, reason: "target_not_node" };
        if (!device.capabilities.includes("shell"))
          return { ok: false, reason: "target_lacks_shell" };
        // Routable only with a live, authenticated channel: a recent check-in is not enough.
        if (!(o.isLive?.(device.id) ?? false)) return { ok: false, reason: "target_offline" };
        const id = randomUUID();
        await tx.query(
          `INSERT INTO tasks (id, account_id, target_device_id, created_by, type, state, spec, idempotency_key, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'process','queued',$5,$6,$7,$7)`,
          [
            id,
            accountId,
            input.targetDeviceId,
            createdBy,
            JSON.stringify(input.spec),
            input.idempotencyKey ?? null,
            now(),
          ],
        );
        await appendEvent(tx, id, "task.created", { executable: input.spec.executable });
        return { ok: true, created: true, task: toTaskView(await reload(tx, id)) };
      });
    },
    async get(accountId: string, id: string): Promise<TaskView | null> {
      const rows = await db.query<TaskRow>(
        "SELECT * FROM tasks WHERE id = $1 AND account_id = $2",
        [id, accountId],
      );
      return rows.rows[0] ? toTaskView(rows.rows[0]) : null;
    },
    async list(accountId: string, limit = 50): Promise<TaskView[]> {
      const rows = await db.query<TaskRow>(
        "SELECT * FROM tasks WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT $2",
        [accountId, Math.min(Math.max(limit, 1), 100)],
      );
      return rows.rows.map(toTaskView);
    },
    async events(
      accountId: string,
      id: string,
      after = 0,
      limit = 200,
    ): Promise<TaskEventView[] | null> {
      const owned = await db.query("SELECT 1 FROM tasks WHERE id = $1 AND account_id = $2", [
        id,
        accountId,
      ]);
      if (!owned.rows.length) return null;
      const rows = await db.query<{
        sequence: number;
        type: string;
        ts: Date | string;
        payload: Record<string, unknown>;
      }>(
        "SELECT sequence, type, ts, payload FROM task_events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3",
        [id, after, Math.min(Math.max(limit, 1), 500)],
      );
      return rows.rows.map((r) => ({
        sequence: r.sequence,
        type: r.type,
        ts: iso(r.ts)!,
        payload: r.payload,
      }));
    },

    /** Human cancel. Never claims `cancelled` for a started process until the node confirms (or force). */
    async cancel(accountId: string, id: string, force = false) {
      return db.transaction(async (tx) => {
        const row = await lock(tx, id);
        if (!row || row.account_id !== accountId) return null;
        if (TERMINAL.includes(row.state))
          return { task: toTaskView(row), notifyDeviceId: null as string | null };
        if (row.state === "queued") {
          await setState(tx, id, "cancelled", {
            finished: true,
            result: { reason: "cancelled", ran: false },
          });
          await appendEvent(tx, id, "task.cancelled", { acknowledged: true, ran: false });
          return { task: toTaskView(await reload(tx, id)), notifyDeviceId: null };
        }
        if (force) {
          await setState(tx, id, "cancelled", {
            finished: true,
            result: { reason: "cancelled", acknowledged: false },
          });
          await appendEvent(tx, id, "task.cancelled", { acknowledged: false });
          return { task: toTaskView(await reload(tx, id)), notifyDeviceId: row.target_device_id };
        }
        if (row.state !== "cancelling") {
          await setState(tx, id, "cancelling");
          await appendEvent(tx, id, "task.cancel_requested", {});
        }
        return { task: toTaskView(await reload(tx, id)), notifyDeviceId: row.target_device_id };
      });
    },

    /** Moves the next queued task to dispatching (one active task per node) and returns the offer. */
    async dispatchNext(deviceId: string) {
      return db.transaction(async (tx) => {
        await tx.query("SELECT id FROM devices WHERE id = $1 FOR UPDATE", [deviceId]);
        const busy = await tx.query(
          `SELECT 1 FROM tasks WHERE target_device_id = $1 AND state IN ('dispatching','running','running_unknown','cancelling') LIMIT 1`,
          [deviceId],
        );
        if (busy.rows.length) return null;
        const next = (
          await tx.query<TaskRow>(
            "SELECT * FROM tasks WHERE target_device_id = $1 AND state = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE",
            [deviceId],
          )
        ).rows[0];
        if (!next) return null;
        await tx.query(
          "UPDATE tasks SET state = 'dispatching', attempt = attempt + 1, assigned_at = $2, updated_at = $2 WHERE id = $1",
          [next.id, now()],
        );
        await appendEvent(tx, next.id, "task.assigned", { attempt: next.attempt + 1 });
        return { taskId: next.id, attempt: next.attempt + 1, spec: next.spec };
      });
    },

    // ---- node → server handlers: every one is fenced by the AUTHENTICATED device id ----
    async accept(deviceId: string, m: { taskId: string; attempt: number }) {
      return db.transaction(async (tx) => {
        const row = await lock(tx, m.taskId, deviceId);
        if (!row || row.attempt !== m.attempt || TERMINAL.includes(row.state))
          return { status: "stale" as const };
        if (row.state === "dispatching" || row.state === "running_unknown") {
          await setState(tx, row.id, "running", { started: true });
          await appendEvent(
            tx,
            row.id,
            row.state === "dispatching" ? "task.accepted" : "task.reconciled",
            {},
          );
        }
        return { status: "ok" as const, cancel: row.state === "cancelling" };
      });
    },
    async reject(deviceId: string, m: { taskId: string; attempt: number; reason: string }) {
      return db.transaction(async (tx) => {
        const row = await lock(tx, m.taskId, deviceId);
        if (!row || row.attempt !== m.attempt || row.state !== "dispatching") return;
        const result = { reason: "rejected", detail: m.reason.slice(0, 200) };
        await setState(tx, row.id, "failed", { finished: true, result });
        await appendEvent(tx, row.id, "process.failed", result);
      });
    },
    async event(
      deviceId: string,
      m: {
        taskId: string;
        attempt: number;
        seq: number;
        event: NodeEventType;
        payload: Record<string, unknown>;
      },
    ) {
      return db.transaction(async (tx) => {
        const row = await lock(tx, m.taskId, deviceId);
        // "gone": unknown, terminal or superseded — the node may drop its copy.
        if (!row || row.attempt !== m.attempt || TERMINAL.includes(row.state)) {
          return { status: "gone" as const };
        }
        // "ignored": not yet in a state that takes events (e.g. the accept is still in flight).
        if (!["running", "cancelling", "running_unknown"].includes(row.state)) {
          return { status: "ignored" as const };
        }
        if (row.state === "running_unknown") {
          await setState(tx, row.id, "running");
          await appendEvent(tx, row.id, "task.reconciled", {});
        }
        if (m.event === "process.output") {
          const bytes = Buffer.byteLength(String(m.payload.text));
          if (row.output_bytes + bytes > o.maxOutputBytes) {
            // Control-plane backstop: record the truncation once, then drop further output.
            if (row.output_bytes <= o.maxOutputBytes) {
              await tx.query("UPDATE tasks SET output_bytes = $2 WHERE id = $1", [
                row.id,
                o.maxOutputBytes + 1,
              ]);
              await appendEvent(tx, row.id, "process.truncated", {
                stream: "both",
                limitBytes: o.maxOutputBytes,
                by: "control-plane",
              });
            }
            return { status: "ok" as const, seq: m.seq };
          }
          await tx.query("UPDATE tasks SET output_bytes = output_bytes + $2 WHERE id = $1", [
            row.id,
            bytes,
          ]);
        }
        await appendEvent(tx, row.id, m.event, m.payload, m.seq);
        return { status: "ok" as const, seq: m.seq };
      });
    },
    async finish(
      deviceId: string,
      m: {
        taskId: string;
        attempt: number;
        seq: number;
        ok: boolean;
        reason?: FailReason;
        result: TaskResult;
      },
    ) {
      return db.transaction(async (tx) => {
        const row = await lock(tx, m.taskId, deviceId);
        if (!row) return { status: "stale" as const };
        // A duplicate or late terminal message is acknowledged and changes nothing.
        if (TERMINAL.includes(row.state)) return { status: "duplicate" as const, seq: m.seq };
        if (row.attempt !== m.attempt) return { status: "stale" as const };
        const wasCancelling = row.state === "cancelling";
        const result = { ...m.result, ...(m.reason ? { reason: m.reason } : {}) };
        if (m.ok) {
          await setState(tx, row.id, "completed", { finished: true, started: true, result });
          await appendEvent(tx, row.id, "process.completed", result, m.seq);
        } else if (m.reason === "cancelled" && wasCancelling) {
          await setState(tx, row.id, "cancelled", {
            finished: true,
            result: { ...result, acknowledged: true },
          });
          await appendEvent(tx, row.id, "task.cancelled", { acknowledged: true }, m.seq);
        } else {
          await setState(tx, row.id, "failed", { finished: true, result });
          await appendEvent(tx, row.id, "process.failed", result, m.seq);
        }
        return { status: "ok" as const, seq: m.seq };
      });
    },
    /** Node reconnect: reconcile what the server believes against what the node actually holds. */
    async sync(deviceId: string, active: { taskId: string; attempt: number }[]) {
      return db.transaction(async (tx) => {
        const held = new Map(active.map((a) => [a.taskId, a.attempt]));
        const rows = await tx.query<TaskRow>(
          `SELECT * FROM tasks WHERE target_device_id = $1 AND state IN ('dispatching','running','running_unknown','cancelling') FOR UPDATE`,
          [deviceId],
        );
        const cancel: string[] = [];
        for (const row of rows.rows) {
          const attempt = held.get(row.id);
          held.delete(row.id);
          if (attempt !== undefined && attempt === row.attempt) {
            if (row.state === "running_unknown" || row.state === "dispatching") {
              await setState(tx, row.id, "running", { started: true });
              await appendEvent(tx, row.id, "task.reconciled", { source: "node-sync" });
            }
            if (row.state === "cancelling") cancel.push(row.id);
            continue;
          }
          if (attempt !== undefined) {
            cancel.push(row.id); // stale attempt on the node: it must not keep running
            continue;
          }
          if (row.state === "dispatching") {
            await setState(tx, row.id, "queued");
            await appendEvent(tx, row.id, "task.requeued", { reason: "node_does_not_hold_task" });
          } else if (row.state === "cancelling") {
            await setState(tx, row.id, "cancelled", {
              finished: true,
              result: { reason: "cancelled", acknowledged: true, note: "not running on node" },
            });
            await appendEvent(tx, row.id, "task.cancelled", {
              acknowledged: true,
              note: "not running on node",
            });
          } else {
            const result = {
              reason: "interrupted",
              detail: "The node no longer holds this task (restart or lost process).",
            };
            await setState(tx, row.id, "failed", { finished: true, result });
            await appendEvent(tx, row.id, "process.failed", result);
          }
        }
        // Anything the node still runs that the server does not want (terminal/unknown): stop it.
        for (const taskId of held.keys()) cancel.push(taskId);
        return { cancel };
      });
    },
    /** Channel dropped: running work is "unknown", never assumed failed. */
    async markDisconnected(deviceId: string) {
      await db.transaction(async (tx) => {
        const rows = await tx.query<TaskRow>(
          `SELECT * FROM tasks WHERE target_device_id = $1 AND state IN ('dispatching','running') FOR UPDATE`,
          [deviceId],
        );
        for (const row of rows.rows) {
          if (row.state === "running") {
            await setState(tx, row.id, "running_unknown");
            await appendEvent(tx, row.id, "task.node_disconnected", {});
          } else {
            await setState(tx, row.id, "queued");
            await appendEvent(tx, row.id, "task.requeued", { reason: "node_disconnected" });
          }
        }
      });
    },
    /** Periodic + startup reconciliation; safe to run any time and across restarts. */
    async sweep() {
      await db.transaction(async (tx) => {
        const t = now();
        // Offers nobody took.
        const stale = await tx.query<TaskRow>(
          `SELECT * FROM tasks WHERE state = 'dispatching' AND assigned_at < $1 FOR UPDATE`,
          [new Date(clock() - o.offerTimeoutMs)],
        );
        for (const row of stale.rows) {
          if (row.attempt >= MAX_OFFER_ATTEMPTS) {
            const result = { reason: "offer_unacknowledged" };
            await setState(tx, row.id, "failed", { finished: true, result });
            await appendEvent(tx, row.id, "process.failed", result);
          } else {
            await setState(tx, row.id, "queued");
            await appendEvent(tx, row.id, "task.requeued", { reason: "offer_timeout" });
          }
        }
        // Running tasks whose device has no live channel (e.g. after a control-plane restart).
        const running = await tx.query<TaskRow>(
          `SELECT * FROM tasks WHERE state = 'running' FOR UPDATE`,
        );
        for (const row of running.rows) {
          if (o.isLive?.(row.target_device_id)) continue;
          await setState(tx, row.id, "running_unknown");
          await appendEvent(tx, row.id, "task.node_disconnected", {});
        }
        // Never run a stale command hours later.
        const expired = await tx.query<TaskRow>(
          `SELECT * FROM tasks WHERE state = 'queued' AND created_at < $1 FOR UPDATE`,
          [new Date(clock() - o.queueTtlMs)],
        );
        for (const row of expired.rows) {
          const result = { reason: "queue_expired" };
          await setState(tx, row.id, "failed", { finished: true, result });
          await appendEvent(tx, row.id, "process.failed", result);
        }
        // Revoked devices can never run anything.
        const orphaned = await tx.query<TaskRow>(
          `SELECT t.* FROM tasks t JOIN devices d ON d.id = t.target_device_id
           WHERE d.revoked_at IS NOT NULL AND t.state IN ('queued','dispatching','running','running_unknown','cancelling') FOR UPDATE OF t`,
        );
        for (const row of orphaned.rows) {
          const result = { reason: "device_revoked" };
          await setState(tx, row.id, "failed", { finished: true, result });
          await appendEvent(tx, row.id, "process.failed", result);
        }
        void t;
      });
    },
  };
}
export type TaskService = ReturnType<typeof createTaskService>;
