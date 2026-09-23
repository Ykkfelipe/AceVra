// CUA-1.75 host-owned transport contract (see specs/computer-use.md, "CUA-1.5" and
// "CUA-1.75"). The trusted host creates the session endpoint; the Helper connects out and is
// admitted only after the connection is bound to the peer's kernel identity, that exact
// process instance's code signature passes the pinned requirement, and the peer's exec args
// equal the launch contract this host minted.

export { BROKER_SOCKET_ENV, BROKER_TOKEN_ENV } from "./broker.js";

export declare const HELLO_TYPE: "helper_hello";

export interface CuaHostTransportHelloPolicy {
  launchToken: string;
  expectedHelperIdentifiers: readonly string[];
  /** The helper-side argv this launch minted (hostConnectHelperArgv of the launch spec). */
  expectedHelperArgv: readonly string[] | null;
}

/** The native peer-binding report the probe produces for one accepted socket, or null. */
export interface PeerBindingReport {
  pid: number;
  pidversion: number;
  binding: Record<string, unknown>;
  identity: Record<string, unknown> | null;
  peerArgs: string[];
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
        | "peer_identity_unavailable"
        | "helper_identity_policy_missing"
        | "helper_identity_missing"
        | "helper_identity_unverified"
        | "helper_identity_adhoc"
        | "helper_identity_mismatch"
        | "helper_process_unverified"
        | "helper_launch_contract_mismatch";
      reason: string;
    };

/** Pure admission policy for one `helper_hello` line (host-derived facts come in via policy). */
export declare function evaluateHelperHello(
  hello: unknown,
  policy: CuaHostTransportHelloPolicy,
  peerBinding: PeerBindingReport | null,
): HelperHelloVerdict;

/** Constant-time capability-token comparison (length-independent, digest-keyed). */
export declare function tokensMatch(presented: unknown, expected: string): boolean;

export interface HostConnectLaunchSpec {
  appPath?: string;
  socketPath: string;
  launchToken: string;
  /** Full designated requirement the Helper must observe in the listener. */
  hostRequirement: string;
  /** Full designated requirement the Helper's own signature must satisfy. */
  helperRequirement: string;
  observationDir: string;
  idleMs?: number;
}

/** The `/usr/bin/open` argv for a host-connect Helper launch. */
export declare function buildHostConnectOpenArgs(spec: HostConnectLaunchSpec): string[];

/** The helper-side argv (everything after `open -a <app> --args`) — the launch contract. */
export declare function hostConnectHelperArgv(
  spec: Omit<HostConnectLaunchSpec, "appPath">,
): string[];

/**
 * Exact equality between a connected peer's exec args and the minted launch contract
 * (flag-name and flag-value equality, count included; argv[0] is not part of the contract).
 */
export declare function helperArgvMatches(
  peerArgs: readonly string[],
  expectedArgv: readonly string[],
): boolean;

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
 * Gate for the peer-identity probe binary itself: its on-disk designated requirement must
 * EQUAL the session-pinned `expectedRequirement`, carry the expected probe identifier, not be
 * ad-hoc signed, and validate strictly against the pinned requirement. The probe is trusted
 * code in the admission chain, so its verdicts are trusted only after this passes.
 */
export declare function verifyPeerProbe(
  probePath: string,
  expectedRequirement: string,
  runTool: (file: string, args: string[], options?: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean>;

export declare class CuaHostTransportError extends Error {
  code: string;
  constructor(message: string, options?: { code?: string });
}

export interface LaunchContract {
  /** Full designated requirement the Helper must observe in the listener. */
  hostRequirement: string;
  /** Full designated requirement the Helper's own signature must satisfy (the probe's check). */
  helperRequirement: string;
  observationDir: string;
  idleMs?: number;
}

export interface CreateCuaBrokerHostOptions {
  env?: NodeJS.ProcessEnv;
  /** Runtime data root; defaults to ZCODE_HOME or ~/.zcode. */
  dataRoot?: string;
  expectedHelperIdentifiers?: readonly string[];
  /** The pinned requirements and launch inputs the Helper was launched with. */
  launchContract?: LaunchContract;
  /** Path to the native peer-identity probe binary (default binder). */
  peerProbePath?: string;
  /**
   * The probe binary's own designated requirement, pinned at session start (launcher-read).
   * The binder re-verifies the probe against it before every spawn; when omitted the gate
   * falls back to `launchContract.helperRequirement`, which a real probe does not satisfy —
   * so a session that cannot pin the probe refuses admission (fail closed).
   */
  peerProbeRequirement?: string;
  /** Test/diagnostic seam: replaces the native probe spawn entirely. */
  bindPeerIdentity?: (socket: import("node:net").Socket) => Promise<PeerBindingReport | null>;
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
