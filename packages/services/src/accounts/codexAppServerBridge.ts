/**
 * Host-side Codex App Server bridge.
 *
 * Owns exactly one `codex app-server` child process per ZCode host process and speaks the
 * documented newline-delimited JSON-RPC protocol over its stdio. Verified against
 * codex-cli 0.155.0-alpha.9.2: `initialize` returns
 * `{ userAgent, codexHome, platformFamily, platformOs }` and `account/read` returns
 * `{ requiresOpenaiAuth, account }` where the chatgpt account variant is
 * `{ type, email, planType }` — no token field exists in that response.
 *
 * SECURITY: this module is one of the only components permitted to talk to the local Codex
 * client. It must never return, log or persist OAuth tokens, refresh tokens or the contents
 * of `~/.codex/auth.json`. It maps into the sanitized `AccountBridge*` types before
 * returning. The OAuth `authUrl` never leaves the host: it is handed to the host's default
 * browser and is deliberately absent from every returned type.
 *
 * Lifecycle, per design decision:
 * - lazy start on first operation
 * - one initialized App Server per host process
 * - clean shutdown with the host
 * - bounded automatic restart after unexpected death
 * - generation fencing so a stale process cannot satisfy a newer request
 * - stdio only; no TCP port is opened
 * - does not require ChatGPT.app to be running
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("codex-bridge");

/** Bundled location on macOS. Codex is not on PATH when installed via ChatGPT.app. */
const CODEX_BUNDLED_MACOS = "/Applications/ChatGPT.app/Contents/Resources/codex";

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 20_000;

export interface CodexBridgeOptions {
  /** Override the executable path; defaults to the bundled macOS location or `codex`. */
  readonly executablePath?: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

interface PendingRequest {
  readonly generation: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Codex 服务器 → 客户端请求（审批等）的原生消息。rawId 是 JSON-RPC request id，
 * 必须原样回传 `{jsonrpc:"2.0", id, result}`；params 内不含任何凭证材料。
 */
export interface CodexServerRequestMessage {
  readonly method: string;
  readonly params: unknown;
  readonly rawId: number;
}

export type CodexNotificationHandler = (
  method: string,
  params: unknown,
  rawRequest?: CodexServerRequestMessage,
) => void;

export function resolveCodexExecutable(override?: string): string | undefined {
  if (override?.trim()) return existsSync(override.trim()) ? override.trim() : undefined;
  if (existsSync(CODEX_BUNDLED_MACOS)) return CODEX_BUNDLED_MACOS;
  return undefined;
}

export class CodexAppServerBridge {
  readonly #executable: string | undefined;
  readonly #clientName: string;
  readonly #clientVersion: string;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationHandlers = new Set<CodexNotificationHandler>();

  #child: ChildProcessWithoutNullStreams | null = null;
  #stdoutBuffer = "";
  #nextRequestId = 1;
  /** Incremented on every (re)start; fences stale responses from a dead process. */
  #generation = 0;
  /** 服务器请求 rawId → 派发时的 generation；respond 时校验，防止跨代误答。 */
  readonly #pendingServerRequests = new Map<number, number>();
  #starting: Promise<void> | null = null;
  #initializeResult: Record<string, unknown> | null = null;
  #restartTimestamps: number[] = [];
  #disposed = false;

  constructor(options: CodexBridgeOptions = {}) {
    this.#executable = resolveCodexExecutable(options.executablePath);
    this.#clientName = options.clientName ?? "zcode-fork";
    this.#clientVersion = options.clientVersion ?? "0.0.0";
  }

  get installed(): boolean {
    return Boolean(this.#executable);
  }

  get executablePath(): string | undefined {
    return this.#executable;
  }

  get generation(): number {
    return this.#generation;
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  /** Lazily start and initialize. Safe to call concurrently. */
  async ensureStarted(): Promise<void> {
    if (this.#disposed) throw new Error("Codex bridge disposed");
    if (!this.#executable) throw new Error("codex_not_installed");
    if (this.#child && this.#initializeResult) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const generation = ++this.#generation;
    // stdio transport only: no --listen, so no TCP port is ever opened.
    const child = spawn(this.#executable!, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;
    this.#stdoutBuffer = "";
    this.#initializeResult = null;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onStdout(chunk, generation));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      // stderr may carry diagnostics; it must never be surfaced verbatim to a client.
      if (text) logger.debug(undefined, `[codex app-server stderr] ${text.slice(0, 400)}`);
    });
    child.on("exit", (code, signal) => this.#onExit(generation, code, signal));
    child.on("error", (error) => {
      logger.error(undefined, `codex app-server spawn error: ${String(error)}`);
      this.#failGeneration(generation, new Error("codex_spawn_failed"));
    });

    const result = (await this.#request(
      "initialize",
      {
        clientInfo: {
          name: this.#clientName,
          title: "ZCode Fork",
          version: this.#clientVersion,
        },
      },
      generation,
      INITIALIZE_TIMEOUT_MS,
    )) as Record<string, unknown>;
    this.#initializeResult = result ?? {};
    logger.info(
      undefined,
      `codex app-server initialized generation=${generation} platform=${String(result?.platformOs ?? "?")}`,
    );
  }

  #onStdout(chunk: string, generation: number): void {
    if (generation !== this.#generation) return; // fenced: output from a superseded process
    this.#stdoutBuffer += chunk;
    for (;;) {
      const index = this.#stdoutBuffer.indexOf("\n");
      if (index < 0) break;
      const line = this.#stdoutBuffer.slice(0, index).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        logger.warn(undefined, "codex app-server emitted a non-JSON line");
        continue;
      }
      this.#dispatch(message, generation);
    }
  }

  #dispatch(message: Record<string, unknown>, generation: number): void {
    const id = message.id;
    if (typeof id === "number" && this.#pending.has(id)) {
      const pending = this.#pending.get(id)!;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      // Fence again at delivery: a response must match the generation that asked.
      if (pending.generation !== generation) {
        pending.reject(new Error("codex_stale_generation"));
        return;
      }
      if (message.error) {
        const errObj = message.error as { message?: string; code?: number };
        pending.reject(new Error(`codex_rpc_error:${errObj.code ?? ""}:${errObj.message ?? ""}`));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      // 服务器请求（审批）带请求 id；登记派发代数供 respond 校验，原样交给 handler。
      const rawId = typeof id === "number" ? id : null;
      if (rawId !== null) {
        // 有界：溢出丢最旧的登记（该请求将无法应答，Codex 侧按超时处理）。
        if (this.#pendingServerRequests.size >= 64) {
          const oldest = this.#pendingServerRequests.keys().next().value;
          if (oldest !== undefined) this.#pendingServerRequests.delete(oldest);
        }
        this.#pendingServerRequests.set(rawId, generation);
      }
      const rawRequest =
        rawId !== null ? { method: message.method, params: message.params, rawId } : undefined;
      for (const handler of this.#notificationHandlers) {
        try {
          handler(message.method, message.params, rawRequest);
        } catch (error) {
          logger.warn(undefined, `codex notification handler threw: ${String(error)}`);
        }
      }
    }
  }

  #onExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (generation !== this.#generation) return;
    logger.warn(undefined, `codex app-server exited code=${code} signal=${signal}`);
    this.#child = null;
    this.#initializeResult = null;
    this.#failGeneration(generation, new Error("codex_process_exited"));
    if (this.#disposed) return;
    if (!this.#withinRestartBudget()) {
      logger.error(undefined, "codex app-server restart budget exhausted; not restarting");
      return;
    }
    void this.ensureStarted().catch((error) => {
      logger.error(undefined, `codex app-server restart failed: ${String(error)}`);
    });
  }

  #withinRestartBudget(): boolean {
    const now = Date.now();
    this.#restartTimestamps = this.#restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.#restartTimestamps.length >= MAX_RESTARTS) return false;
    this.#restartTimestamps.push(now);
    return true;
  }

  /**
   * Reject every request belonging to a generation that is no longer live.
   * Deleting the current entry while iterating a Map is well-defined, so no copy is needed.
   */
  #failGeneration(generation: number, error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.generation !== generation) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #request(
    method: string,
    params: unknown,
    generation: number,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("codex_not_running"));
    const id = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`codex_timeout:${method}`));
      }, timeoutMs);
      this.#pending.set(id, { generation, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Public request entry point; starts the server if needed and fences on the live generation. */
  async call<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    await this.ensureStarted();
    return (await this.#request(method, params, this.#generation, timeoutMs)) as T;
  }

  /**
   * 应答一条服务器 → 客户端请求（如审批）。generation fence：只应答在本代进程内派发、
   * 且当前仍在live 进程上的请求；登记缺失或代数不符时静默丢弃，绝不写入新进程的 stdin。
   */
  respond(rawId: number, result: unknown): void {
    const dispatchedGeneration = this.#pendingServerRequests.get(rawId);
    if (dispatchedGeneration === undefined) return;
    this.#pendingServerRequests.delete(rawId);
    if (dispatchedGeneration !== this.#generation) return;
    const child = this.#child;
    if (!child) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rawId, result })}\n`);
  }

  get initializeInfo(): Record<string, unknown> | null {
    return this.#initializeResult;
  }

  /**
   * Stop the child process WITHOUT retiring the bridge. Used by "disconnect from harness"
   * and by bridge reconnect, both of which must leave the bridge restartable.
   */
  stop(): void {
    this.#failGeneration(this.#generation, new Error("codex_bridge_stopped"));
    this.#pendingServerRequests.clear();
    this.#generation += 1; // fence any late output from the process we are killing
    this.#child?.kill();
    this.#child = null;
    this.#initializeResult = null;
    this.#stdoutBuffer = "";
    this.#restartTimestamps = [];
  }

  /** Terminal teardown for host shutdown. The bridge cannot be restarted afterwards. */
  dispose(): void {
    this.#disposed = true;
    this.stop();
    this.#notificationHandlers.clear();
  }
}
