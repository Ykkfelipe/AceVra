// CUA-1.5 hardened Helper transport session (darwin) — services-side wiring.
//
// Owns the *launch* of a Helper into a host-owned transport session:
// the host endpoint (createCuaBrokerHost in @zcode/zcode-cua/broker/hostTransport) is created
// first, then the Helper is launched through LaunchServices with the connect-mode arguments
// (spec "Launch contract"), and the session is ready only once the Helper presented a hello
// that passed admission (launch token + host-derived codesign validation).
//
// Failure posture: every failure returns `{ ok: false, reason }` with a stable reason code and
// tears the session down — the caller (services/node.ts) decides fallback to the CUA-1
// standalone flow. Nothing in here silently degrades: a half-started hardened session would
// re-open exactly the gap this phase closes.
//
// Launch-argument facts worth restating (measured, see spec): LaunchServices does not forward
// the launcher's environment, so socket path, token and both designated requirements travel in
// `--args`; the host's own requirement is read from the running executable's signature via
// `codesign -d -r-`, which resolves for signed apps (identifier + certificate/team anchored)
// and for ad-hoc dev builds (cdhash anchored) alike.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  BROKER_TOKEN_ENV,
  buildHostConnectOpenArgs,
  createCuaBrokerHost,
  readDesignatedRequirement,
  type CuaBrokerHost,
} from "@zcode/zcode-cua/broker/hostTransport";
import { resolveExpectedHelperIdentifiers } from "@zcode/zcode-cua/broker";
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";

export { BROKER_TOKEN_ENV };

export interface HardenedCuaHelperSession {
  readonly host: CuaBrokerHost;
  readonly socketPath: string;
  readonly token: string;
  readonly helperAppPath: string;
  /**
   * Launch the Helper again into the SAME session (same socket path, token and pinned
   * requirements). Used after the helper connection dropped — the relay admits the new hello
   * and the session identity never changes.
   */
  relaunch(): Promise<boolean>;
  stop(): Promise<void>;
}

export type HardenedCuaHelperSessionStart =
  | { ok: true; session: HardenedCuaHelperSession }
  | { ok: false; reason: string };

export interface HardenedCuaHelperSessionOptions {
  env?: NodeJS.ProcessEnv;
  logger?: {
    warn: (contextId: undefined, message: string, fields?: Record<string, unknown>) => void;
  };
  /** Total budget for Helper launch + hello admission. */
  admissionTimeoutMs?: number;
}

/** Install candidates, same layout the CUA-1 settings flow enumerates (spec "Install path"). */
function dataRootOf(env: NodeJS.ProcessEnv) {
  const home = env?.ZCODE_HOME?.trim() || join(homedir(), ".zcode");
  return {
    home,
    baseRoot: join(home, "computer-use"),
  };
}

function helperAppCandidates(env: NodeJS.ProcessEnv) {
  const { baseRoot } = dataRootOf(env);
  return [
    join(baseRoot, "dev", DEV_HELPER_APP_NAME),
    join(baseRoot, "dev", HELPER_APP_NAME),
    join(baseRoot, HELPER_APP_NAME),
    join(baseRoot, "preview", HELPER_APP_NAME),
  ];
}

export function resolveHelperAppCandidate(env: NodeJS.ProcessEnv = process.env): string | null {
  return helperAppCandidates(env).find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Start a hardened session: host endpoint → pinned requirements → Helper launch → admission.
 * Darwain-only; on any other platform this reports a stable failure so callers fall back.
 */
export async function startHardenedCuaHelperSession(
  options: HardenedCuaHelperSessionOptions = {},
): Promise<HardenedCuaHelperSessionStart> {
  if (process.platform !== "darwin") return { ok: false, reason: "unsupported_platform" };
  const env = options.env ?? process.env;
  const appPath = resolveHelperAppCandidate(env);
  if (!appPath) return { ok: false, reason: "helper_app_missing" };

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const runTool = promisify(execFile);
  const computerUseRoot = dataRootOf(env).baseRoot;

  // The Helper's own signature must satisfy the requirement pinned at its install path — this
  // is what makes a swapped or re-signed Helper fail its own self-check (CUA-1.5).
  const helperRequirement = await readDesignatedRequirement(appPath, runTool);
  if (!helperRequirement) return { ok: false, reason: "helper_requirement_unavailable" };
  // The Helper, in turn, verifies the listener against the host's own requirement; an unsigned
  // host cannot make that promise and the hardened transport refuses to start (fail closed).
  const hostRequirement = await readDesignatedRequirement(process.execPath, runTool);
  if (!hostRequirement) return { ok: false, reason: "host_identity_unavailable" };

  const host = createCuaBrokerHost({
    env,
    installRoots: [computerUseRoot],
    helperRequirement,
    // 与客户端同一份期望身份列表（碰撞过滤器）；真正承载信任的是 admission 的
    // host-derived codesign 校验，列表只是第一道 refuses-unrelated-binary 的门。
    expectedHelperIdentifiers: resolveExpectedHelperIdentifiers({ env }),
  });
  await host.start();
  const observationDir = join(computerUseRoot, "observations");
  const launchArgs = () =>
    buildHostConnectOpenArgs({
      appPath,
      socketPath: host.socketPath!,
      launchToken: host.token,
      hostRequirement,
      helperRequirement,
      observationDir,
      idleMs: 15_000,
    });
  const launchAndAwaitAdmission = async (): Promise<boolean> => {
    try {
      await runTool("/usr/bin/open", launchArgs(), { timeout: 5_000 });
    } catch (error) {
      // LaunchServices 已接单也可能超时；admission 轮询会给出最终事实。
      options.logger?.warn(undefined, "[cua-host-transport] Helper launch reported an error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const deadline = Date.now() + (options.admissionTimeoutMs ?? 10_000);
    while (!host.helperConnected && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    return host.helperConnected;
  };
  try {
    if (!(await launchAndAwaitAdmission())) {
      options.logger?.warn(undefined, "[cua-host-transport] Helper hello not admitted in time", {
        reason: "helper_not_admitted",
      });
      await host.stop();
      return { ok: false, reason: "helper_not_admitted" };
    }
    const session: HardenedCuaHelperSession = {
      host,
      socketPath: host.socketPath!,
      token: host.token,
      helperAppPath: appPath,
      relaunch: launchAndAwaitAdmission,
      stop: () => host.stop(),
    };
    return { ok: true, session };
  } catch (error) {
    await host.stop().catch(() => undefined);
    options.logger?.warn(undefined, "[cua-host-transport] session start failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "session_start_failed" };
  }
}
