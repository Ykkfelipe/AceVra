import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killTree } from "./kill.js";
import { resolveCwd, resolveRoots } from "./policy.js";
import { buildChildEnv, type ProcessSpec } from "./spec.js";
import { buildBatchInvocation, isBatchFile, resolveWindowsExecutable } from "./windows.js";

export type Stream = "stdout" | "stderr";
type OutcomeBody =
  | { kind: "exit"; exitCode: number | null; signal: string | null }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "spawn_failed"; detail: string };
export type Outcome = OutcomeBody & { durationMs: number; droppedBytes: number };

export interface RunHooks {
  started(pid: number): void;
  /** Return false when the downstream buffer is full: the executor pauses the child's pipes. */
  output(stream: Stream, text: string, bytes: number): boolean;
  /** Called once when the per-task output cap is reached. */
  truncated(limitBytes: number): void;
  /** The executor registers a resume callback; the caller invokes it when space frees up. */
  onDrain(resume: () => void): void;
}

export interface ShellLimits {
  /** Per-task output cap across both streams. */
  maxOutputBytes: number;
  /** Largest single output event (raw bytes). */
  chunkBytes: number;
  /** Coalescing interval. */
  flushMs: number;
}
export const DEFAULT_LIMITS: ShellLimits = {
  maxOutputBytes: 1 << 20,
  chunkBytes: 4096,
  flushMs: 250,
};

export interface PreparedProcess {
  spec: ProcessSpec;
  cwd: string;
}

/**
 * The node's sanctioned process runner. Structured only: executable + args[] spawned with
 * shell:false, a minimal allowlisted environment, a cwd confined to explicitly allowed roots,
 * a timeout, cancellation of the whole tree, and bounded streaming output. No stdin, no TTY,
 * no elevation.
 */
export function createShellService(options: {
  roots: string[];
  limits?: Partial<ShellLimits>;
  env?: NodeJS.ProcessEnv;
}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  let canonicalRoots: string[] | null = null;
  const roots = async () => (canonicalRoots ??= await resolveRoots(options.roots));

  return {
    limits,
    /**
     * Readiness is EARNED, never inferred from the OS: at least one allowed root and a real
     * spawn that exits cleanly. Only then may the node advertise `shell`.
     */
    async ready(): Promise<boolean> {
      try {
        if ((await roots()).length === 0) return false;
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => (child.kill(), resolve(false)), 5000);
          child.once("error", () => (clearTimeout(timer), resolve(false)));
          child.once("exit", (code) => (clearTimeout(timer), resolve(code === 0)));
        });
      } catch {
        return false;
      }
    },
    /** Policy gate: the cwd must resolve inside an allowed root. */
    async prepare(spec: ProcessSpec): Promise<PreparedProcess | { error: string }> {
      const cwd = await resolveCwd(spec.cwd, await roots().catch(() => []));
      return cwd ? { spec, cwd } : { error: "cwd is not inside an allowed root" };
    },
    run(prepared: PreparedProcess, hooks: RunHooks): { cancel(): void; done: Promise<Outcome> } {
      const started = Date.now();
      let cancelled = false;
      let timedOut = false;
      let child: ChildProcess | null = null;
      let dropped = 0;
      let accounted = 0;
      let truncatedReported = false;
      let paused = false;

      const done = new Promise<Outcome>((resolve) => {
        const finish = (outcome: OutcomeBody) =>
          resolve({
            ...outcome,
            durationMs: Date.now() - started,
            droppedBytes: dropped,
          } as Outcome);

        (async () => {
          const env: Record<string, string> = buildChildEnv(prepared.spec.env, options.env);
          let command = prepared.spec.executable;
          let args = prepared.spec.args;
          let extra: { windowsVerbatimArguments?: boolean } = {};
          if (process.platform === "win32") {
            const resolved = await resolveWindowsExecutable(command, env);
            if (!resolved) return finish({ kind: "spawn_failed", detail: "executable not found" });
            if (isBatchFile(resolved)) {
              const batch = buildBatchInvocation(resolved, args, env.ComSpec ?? env.COMSPEC);
              if (!batch)
                return finish({
                  kind: "spawn_failed",
                  detail: "arguments are not allowed for a batch file",
                });
              command = batch.command;
              args = batch.args;
              extra = { windowsVerbatimArguments: true };
            } else {
              command = resolved;
            }
          }
          try {
            child = spawn(command, args, {
              cwd: prepared.cwd,
              env,
              shell: false,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
              detached: process.platform !== "win32",
              ...extra,
            });
          } catch {
            return finish({ kind: "spawn_failed", detail: "spawn failed" });
          }
          const c = child;
          if (c.pid) hooks.started(c.pid);
          const timer = setTimeout(() => {
            timedOut = true;
            killTree(c);
          }, prepared.spec.timeoutMs);

          const lanes = (["stdout", "stderr"] as const).map((stream) => ({
            stream,
            decoder: new StringDecoder("utf8"),
            pending: Buffer.alloc(0),
            source: c[stream]!,
          }));
          const emit = (lane: (typeof lanes)[number], flushAll: boolean) => {
            while (
              lane.pending.length >= limits.chunkBytes ||
              (flushAll && lane.pending.length > 0)
            ) {
              const slice = lane.pending.subarray(0, limits.chunkBytes);
              lane.pending = lane.pending.subarray(slice.length);
              const text = lane.decoder.write(slice);
              if (text && !hooks.output(lane.stream, text, slice.length) && !paused) {
                paused = true;
                for (const l of lanes) l.source.pause();
              }
            }
            if (flushAll) {
              const tail = lane.decoder.end();
              if (tail) hooks.output(lane.stream, tail, Buffer.byteLength(tail));
            }
          };
          hooks.onDrain(() => {
            if (!paused) return;
            paused = false;
            for (const l of lanes) l.source.resume();
          });
          const timers = lanes.map((lane) => {
            lane.source.on("data", (chunk: Buffer) => {
              const room = Math.max(0, limits.maxOutputBytes - accounted);
              const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
              accounted += kept.length;
              if (kept.length < chunk.length) {
                // Truncation is recorded, never silent: one event now, a byte count at the end.
                dropped += chunk.length - kept.length;
                if (!truncatedReported) {
                  truncatedReported = true;
                  hooks.truncated(limits.maxOutputBytes);
                }
              }
              if (kept.length) lane.pending = Buffer.concat([lane.pending, kept]);
              if (lane.pending.length >= limits.chunkBytes) emit(lane, false);
            });
            return setInterval(() => emit(lane, true), limits.flushMs);
          });
          const stop = () => {
            clearTimeout(timer);
            timers.forEach(clearInterval);
          };
          c.once("error", (error: NodeJS.ErrnoException) => {
            stop();
            finish({ kind: "spawn_failed", detail: error.code ?? "spawn error" });
          });
          c.once("close", (exitCode, signal) => {
            stop();
            lanes.forEach((lane) => emit(lane, true));
            if (cancelled) return finish({ kind: "cancelled" });
            if (timedOut) return finish({ kind: "timeout" });
            finish({ kind: "exit", exitCode, signal });
          });
        })().catch(() => finish({ kind: "spawn_failed", detail: "unexpected error" }));
      });

      return {
        done,
        cancel() {
          if (cancelled) return;
          cancelled = true;
          if (child) killTree(child);
        },
      };
    },
  };
}
export type ShellService = ReturnType<typeof createShellService>;
