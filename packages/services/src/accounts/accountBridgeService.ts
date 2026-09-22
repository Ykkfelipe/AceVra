/**
 * Accounts & Imports — host-side account connection service.
 *
 * Two adapters behind one interface:
 * - Codex: JSON-RPC over a persistent `codex app-server` stdio child (CodexAppServerBridge).
 * - Claude Code: its documented CLI auth surface (`claude auth status --json`,
 *   `claude auth login`). `setup-token` is deliberately NOT used, because it would place a
 *   long-lived credential in ZCode's custody.
 *
 * SECURITY BOUNDARY
 * - Only this module and CodexAppServerBridge talk to the local source applications.
 * - Every public method returns sanitized `AccountBridge*` types. No OAuth access token,
 *   refresh token, `auth.json` content or Claude credential is read, copied, logged,
 *   persisted or returned.
 * - The Codex OAuth `authUrl` is opened on the HOST and is never included in a return value,
 *   because the documented Codex callback targets localhost on this machine.
 * - "Disconnect" disables the harness-side bridge ONLY. It never calls `account/logout` or
 *   `claude auth logout`, so the user's Codex and Claude logins are preserved.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AccountBridgeConnectResult,
  AccountBridgeIdentity,
  AccountBridgeSource,
  AccountBridgeStatus,
  AccountBridgeUsage,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { CodexAppServerBridge } from "#src/accounts/codexAppServerBridge.js";

const execFileAsync = promisify(execFile);
const logger = createServiceLogger("account-bridge");

const LOGIN_COMPLETION_TIMEOUT_MS = 5 * 60_000;

/** Harness-side link state, persisted per source. Contains no credential material. */
interface HarnessLinkState {
  enabled: boolean;
  lastError?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Never let raw command output reach a client; keep a short, generic reason. */
function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Keep the reason readable but strip anything that could carry secret material:
  // absolute paths, URLs, and long opaque blobs such as JWTs.
  const scrubbed = raw
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\/[\w.\-/]{8,}/g, "<path>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<redacted>");
  return scrubbed.slice(0, 120) || "error";
}

export interface AccountBridgeServiceDeps {
  /** Opens a URL with the host's default browser. Host-side only. */
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly codexExecutablePath?: string;
  readonly claudeExecutablePath?: string;
  readonly clientVersion?: string;
}

export function createAccountBridgeService(deps: AccountBridgeServiceDeps) {
  const codex = new CodexAppServerBridge({
    ...(deps.codexExecutablePath ? { executablePath: deps.codexExecutablePath } : {}),
    ...(deps.clientVersion ? { clientVersion: deps.clientVersion } : {}),
  });
  const claudeBin = deps.claudeExecutablePath ?? "claude";

  const links: Record<AccountBridgeSource, HarnessLinkState> = {
    codex: { enabled: false },
    "claude-code": { enabled: false },
  };

  /** Latest login completion, keyed by the opaque loginId. No credential material. */
  const loginCompletions = new Map<string, { success: boolean; error?: string }>();
  // Exact method name taken from the generated ServerNotification schema.
  const CODEX_LOGIN_COMPLETED = "account/login/completed";
  codex.onNotification((method, params) => {
    if (method !== CODEX_LOGIN_COMPLETED) return;
    const p = (params ?? {}) as { loginId?: string; success?: boolean; error?: string };
    if (typeof p.loginId === "string") {
      loginCompletions.set(p.loginId, {
        success: Boolean(p.success),
        ...(p.error ? { error: String(p.error).slice(0, 120) } : {}),
      });
    }
  });

  // ---------------------------------------------------------------- Codex

  function mapCodexIdentity(account: Record<string, unknown> | null): AccountBridgeIdentity | undefined {
    if (!account) return undefined;
    const email = typeof account.email === "string" ? account.email : undefined;
    const planType = typeof account.planType === "string" ? account.planType : undefined;
    if (!email && !planType) return undefined;
    return { ...(email ? { email } : {}), ...(planType ? { planType } : {}) };
  }

  function mapCodexUsage(raw: Record<string, unknown> | null): AccountBridgeUsage | undefined {
    if (!raw) return undefined;
    const allowed = typeof raw.ordinaryUsageAllowed === "boolean" ? raw.ordinaryUsageAllowed : undefined;
    if (allowed === undefined) return undefined;
    return { ordinaryUsageAllowed: allowed };
  }

  /** Cheap version read that does NOT start the app-server child process. */
  async function readCodexVersion(): Promise<string | undefined> {
    const bin = codex.executablePath;
    if (!bin) return undefined;
    try {
      const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 15_000 });
      return stdout.trim().split(/\s+/).pop();
    } catch {
      return undefined;
    }
  }

  async function readCodexStatus(): Promise<AccountBridgeStatus> {
    const version = await readCodexVersion();
    const base = {
      source: "codex" as const,
      installed: codex.installed,
      ...(version ? { version } : {}),
      checkedAt: nowIso(),
    };
    if (!codex.installed) {
      return { ...base, state: "not-installed", sourceSignedIn: false };
    }
    if (!links.codex.enabled) {
      // Bridge intentionally disabled; do not start the child process.
      return { ...base, state: "disconnected", sourceSignedIn: false };
    }
    try {
      const result = (await codex.call("account/read", {})) as {
        account?: Record<string, unknown> | null;
        requiresOpenaiAuth?: boolean;
      };
      const account = result?.account ?? null;
      let usage: AccountBridgeUsage | undefined;
      try {
        usage = mapCodexUsage(
          (await codex.call("account/rateLimits/read", {})) as Record<string, unknown>,
        );
      } catch {
        usage = undefined; // optional; absence is not an error
      }
      const identity = mapCodexIdentity(account);
      return {
        ...base,
        state: "connected",
        sourceSignedIn: Boolean(account),
        ...(identity ? { identity } : {}),
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      const reason = sanitizeError(error);
      logger.warn(undefined, `codex status read failed: ${reason}`);
      return { ...base, state: "error", sourceSignedIn: false, error: reason };
    }
  }

  async function connectCodex(): Promise<AccountBridgeConnectResult> {
    if (!codex.installed) {
      return {
        source: "codex",
        started: false,
        error: "codex_not_installed",
        status: await readCodexStatus(),
      };
    }
    links.codex.enabled = true;
    try {
      const started = (await codex.call("account/login/start", { type: "chatgpt" })) as {
        authUrl?: string;
        loginId?: string;
        type?: string;
      };
      // If Codex reports an already-usable account without an OAuth round trip, we are done.
      if (!started?.authUrl) {
        return {
          source: "codex",
          started: true,
          completed: true,
          ...(started?.loginId ? { loginId: started.loginId } : {}),
          status: await readCodexStatus(),
        };
      }
      // HOST-SIDE ONLY. The callback targets localhost on this Mac, so the URL is opened
      // here and never returned to a remote browser.
      await deps.openExternalUrl(started.authUrl);
      const loginId = started.loginId;
      const completed = loginId ? await waitForCodexLogin(loginId) : undefined;
      return {
        source: "codex",
        started: true,
        ...(loginId ? { loginId } : {}),
        ...(completed !== undefined ? { completed: completed.success } : {}),
        ...(completed?.error ? { error: completed.error } : {}),
        status: await readCodexStatus(),
      };
    } catch (error) {
      const reason = sanitizeError(error);
      links.codex.lastError = reason;
      return { source: "codex", started: false, error: reason, status: await readCodexStatus() };
    }
  }

  async function waitForCodexLogin(loginId: string): Promise<{ success: boolean; error?: string }> {
    const deadline = Date.now() + LOGIN_COMPLETION_TIMEOUT_MS;
    for (;;) {
      const hit = loginCompletions.get(loginId);
      if (hit) {
        loginCompletions.delete(loginId);
        return hit;
      }
      if (Date.now() > deadline) return { success: false, error: "login_timeout" };
      await new Promise((r) => setTimeout(r, 750));
    }
  }

  async function cancelCodexLogin(loginId?: string): Promise<void> {
    if (!codex.installed) return;
    try {
      await codex.call("account/login/cancel", loginId ? { loginId } : {});
    } catch (error) {
      logger.warn(undefined, `codex login cancel failed: ${sanitizeError(error)}`);
    }
  }

  // ---------------------------------------------------------- Claude Code

  /**
   * `claude auth status --json` exits non-zero when signed out but still prints valid JSON,
   * so a non-zero exit must not be treated as a failure when stdout parses.
   */
  async function claudeExec(args: string[], timeoutMs = 20_000): Promise<string> {
    try {
      const { stdout } = await execFileAsync(claudeBin, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout === "string" && stdout.trim()) return stdout;
      throw error;
    }
  }

  async function readClaudeStatus(): Promise<AccountBridgeStatus> {
    const checkedAt = nowIso();
    let version: string | undefined;
    try {
      version = (await claudeExec(["--version"], 15_000)).trim().split(/\s+/)[0];
    } catch {
      return { source: "claude-code", installed: false, state: "not-installed", sourceSignedIn: false, checkedAt };
    }
    const base = {
      source: "claude-code" as const,
      installed: true,
      ...(version ? { version } : {}),
      checkedAt,
    };
    try {
      const raw = await claudeExec(["auth", "status", "--json"]);
      const parsed = JSON.parse(raw) as {
        loggedIn?: boolean;
        authMethod?: string;
        apiProvider?: string;
      };
      const identity: AccountBridgeIdentity = {
        ...(parsed.authMethod ? { authMethod: parsed.authMethod } : {}),
        ...(parsed.apiProvider ? { apiProvider: parsed.apiProvider } : {}),
      };
      return {
        ...base,
        state: links["claude-code"].enabled ? "connected" : "disconnected",
        sourceSignedIn: Boolean(parsed.loggedIn),
        ...(Object.keys(identity).length ? { identity } : {}),
      };
    } catch (error) {
      return { ...base, state: "error", sourceSignedIn: false, error: sanitizeError(error) };
    }
  }

  async function connectClaude(): Promise<AccountBridgeConnectResult> {
    const before = await readClaudeStatus();
    if (!before.installed) {
      return { source: "claude-code", started: false, error: "claude_not_installed", status: before };
    }
    links["claude-code"].enabled = true;
    if (before.sourceSignedIn) {
      // Already signed in at the source; enabling the bridge is all that is required.
      return { source: "claude-code", started: true, completed: true, status: await readClaudeStatus() };
    }
    try {
      // Explicit user action only. Claude owns the browser flow and its own credentials.
      await claudeExec(["auth", "login", "--claudeai"], LOGIN_COMPLETION_TIMEOUT_MS);
      return { source: "claude-code", started: true, completed: true, status: await readClaudeStatus() };
    } catch (error) {
      const reason = sanitizeError(error);
      links["claude-code"].lastError = reason;
      return { source: "claude-code", started: true, error: reason, status: await readClaudeStatus() };
    }
  }

  // ------------------------------------------------------------- Public API

  return {
    async readStatus(source: AccountBridgeSource): Promise<AccountBridgeStatus> {
      return source === "codex" ? readCodexStatus() : readClaudeStatus();
    },
    async readAllStatuses(): Promise<readonly AccountBridgeStatus[]> {
      return Promise.all([readCodexStatus(), readClaudeStatus()]);
    },
    async connect(source: AccountBridgeSource): Promise<AccountBridgeConnectResult> {
      return source === "codex" ? connectCodex() : connectClaude();
    },
    async cancelConnect(source: AccountBridgeSource, loginId?: string): Promise<void> {
      if (source === "codex") await cancelCodexLogin(loginId);
    },
    /**
     * Disconnect the HARNESS-SIDE bridge only.
     * Deliberately does NOT call Codex `account/logout` or `claude auth logout`.
     */
    async disconnect(source: AccountBridgeSource): Promise<AccountBridgeStatus> {
      links[source].enabled = false;
      delete links[source].lastError;
      // stop(), not dispose(): the harness link is disabled but the bridge stays restartable,
      // and the user's Codex login is untouched either way.
      if (source === "codex") codex.stop();
      logger.info(undefined, `harness bridge disabled for ${source} (source login preserved)`);
      return source === "codex" ? readCodexStatus() : readClaudeStatus();
    },
    /** Restart the Codex bridge process without touching credentials. */
    async reconnectBridge(source: AccountBridgeSource): Promise<AccountBridgeStatus> {
      if (source === "codex") {
        codex.stop();
        links.codex.enabled = true;
        await codex.ensureStarted().catch(() => undefined);
      } else {
        links["claude-code"].enabled = true;
      }
      return source === "codex" ? readCodexStatus() : readClaudeStatus();
    },
    dispose(): void {
      codex.dispose();
    },
  };
}

export type AccountBridgeService = ReturnType<typeof createAccountBridgeService>;
