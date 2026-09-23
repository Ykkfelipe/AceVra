// CUA-1.5 host-owned transport contract (see specs/computer-use.md, "CUA-1.5").
// The trusted host creates the session endpoint; the Helper connects out and is admitted only
// after presenting the launch token and a host-validated process identity.

export { BROKER_SOCKET_ENV, BROKER_TOKEN_ENV } from "./broker.js";

export declare const HELLO_TYPE: "helper_hello";

export interface CuaHostTransportHelloPolicy {
  launchToken: string;
  expectedHelperIdentifiers: readonly string[];
  validatedPids: Set<number>;
}

export type HelperHelloVerdict =
  | {
      admitted: true;
      code: "ok";
      reason: "";
      pid: number;
      identifier: string;
      identity: Record<string, unknown>;
    }
  | {
      admitted: false;
      code:
        | "bad_hello"
        | "wrong_helper_token"
        | "helper_identity_policy_missing"
        | "helper_identity_missing"
        | "helper_identity_unverified"
        | "helper_identity_adhoc"
        | "helper_identity_mismatch"
        | "helper_process_unverified";
      reason: string;
    };

/** Pure admission policy for one `helper_hello` line (host-derived facts come in via policy). */
export declare function evaluateHelperHello(
  hello: unknown,
  policy: CuaHostTransportHelloPolicy,
): HelperHelloVerdict;

/** Constant-time capability-token comparison (length-independent, digest-keyed). */
export declare function tokensMatch(presented: unknown, expected: string): boolean;

export interface HostConnectLaunchSpec {
  appPath: string;
  socketPath: string;
  launchToken: string;
  /** Full designated requirement the Helper must observe in the listener. */
  hostRequirement: string;
  /** Full designated requirement the Helper's own signature must satisfy. */
  helperRequirement: string;
  observationDir: string;
  idleMs?: number;
}

/** The complete `/usr/bin/open` argv for a host-connect Helper launch. */
export declare function buildHostConnectOpenArgs(spec: HostConnectLaunchSpec): string[];

/**
 * The path's designated requirement via `codesign -d -r-`, or null when the code carries no
 * signature (the hardened transport refuses to start unpinned). The runner's resolved value is
 * normalized internally (string, Buffer, or an execFile-style `{ stdout }`).
 */
export declare function readDesignatedRequirement(
  codePath: string,
  runTool: (file: string, args: string[], options?: Record<string, unknown>) => Promise<unknown>,
): Promise<string | null>;

/**
 * Live pids under the helper install roots whose executable's bundle satisfies the helper
 * requirement — the host-derived admission set, computed without trusting the connection.
 */
export declare function collectValidatedHelperPids(options: {
  installRoots: readonly string[];
  requirement: string;
  runTool: (file: string, args: string[]) => Promise<unknown>;
}): Promise<Set<number>>;

export declare class CuaHostTransportError extends Error {
  code: string;
  constructor(message: string, options?: { code?: string });
}

export interface CreateCuaBrokerHostOptions {
  env?: NodeJS.ProcessEnv;
  /** Runtime data root; defaults to ZCODE_HOME or ~/.zcode. */
  dataRoot?: string;
  expectedHelperIdentifiers?: readonly string[];
  /** Helper install roots for the host-derived pid scan (e.g. `<ZCODE_HOME>/computer-use`). */
  installRoots?: readonly string[];
  /** Full helper designated requirement for the pid scan. */
  helperRequirement?: string;
  /** Test hook: replaces the ps + codesign scan entirely. */
  collectValidatedPids?: () => Promise<Set<number>>;
}

export interface AdmittedHelper {
  pid: number;
  identifier: string;
}

export interface CuaBrokerHost {
  readonly token: string;
  readonly socketPath: string | null;
  readonly sessionDir: string | null;
  readonly helperConnected: boolean;
  readonly admittedHelper: AdmittedHelper | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  callMethod<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
}

export declare function createCuaBrokerHost(options?: CreateCuaBrokerHostOptions): CuaBrokerHost;
