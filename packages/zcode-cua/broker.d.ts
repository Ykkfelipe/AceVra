export declare const BROKER_SOCKET_ENV: string;
/** CUA-1.5: per-launch capability token for the host-owned transport session. */
export declare const BROKER_TOKEN_ENV: string;
export declare const BROKER_UNAVAILABLE_ENV: string;
export declare const EXPECTED_HELPER_IDS_ENV: string;

/** Helper signing identifiers this build will talk to, as a fail-closed positive list. */
export declare const DEFAULT_EXPECTED_HELPER_IDENTIFIERS: readonly string[];
export declare function resolveExpectedHelperIdentifiers(options?: {
  env?: Record<string, string | undefined>;
}): string[];

/**
 * The identity a helper reported for itself, resolved from its own code signature by the helper
 * (`SecCodeCheckValidity` + `SecCodeCopySigningInformation`). Never a self-reported bundle string.
 */
export interface HelperIdentityReport {
  verified: boolean;
  identifier: string;
  team_id: string;
  cd_hash: string;
  requirement: string;
  ad_hoc: boolean;
  pid: number;
  expected_identifier: string;
  expectation_source: string;
  reason: string;
}

export interface HelperIdentityVerdict {
  verified: boolean;
  code: string;
  reason: string;
  identifier?: string;
}

export declare function evaluateHelperIdentity(
  identity: unknown,
  expectedIdentifiers: readonly string[],
): HelperIdentityVerdict;

/**
 * Validates a broker response's identity block and refuses a `grant_owner` that disagrees with the
 * verified signing identifier. Throws `BrokerError` with a stable code on any failure.
 */
export declare function assertHelperIdentity(
  response: unknown,
  expectedIdentifiers: readonly string[],
): HelperIdentityVerdict;

export declare class BrokerError extends Error {
  code: string;
  details?: unknown;
  constructor(message?: string, options?: { code?: string; details?: unknown });
}

export declare class CuaHelperError extends Error {
  code: string;
  constructor(message?: string, options?: { code?: string });
}

export declare function isCuaHelperError(value: unknown): value is CuaHelperError;

export declare const notAuthorized: (message?: string, details?: unknown) => BrokerError;
export declare const notSelectable: (message?: string, details?: unknown) => BrokerError;
export declare const notSettable: (message?: string, details?: unknown) => BrokerError;
export declare const elementUnavailable: (message?: string, details?: unknown) => BrokerError;
export declare const actionUnavailable: (message?: string, details?: unknown) => BrokerError;
export declare const foregroundRequired: (message?: string, details?: unknown) => BrokerError;

export interface HelperHealth {
  bundleId: string | null;
  pid: number | null;
  /** `true` when the identity was verified here; absent when the caller opted out. */
  verified?: boolean;
  identity?: HelperIdentityReport;
}

export interface CallBrokerMethodArgs {
  socketPath: string;
  method: string;
  params?: unknown;
  timeoutMs?: number;
  /**
   * Whether the response must carry a verified helper identity. Defaults to `true` on macOS, where
   * the helper can answer the question with a code signature; the Windows development host has its
   * own per-launch pipe/token transport and no code signature, so it opts out.
   */
  requireVerifiedIdentity?: boolean;
  /** Defaults to `resolveExpectedHelperIdentifiers()`. */
  expectedHelperIdentifiers?: readonly string[];
}

export declare function callBrokerMethod<T = unknown>(args: CallBrokerMethodArgs): Promise<T>;

export interface ProbeHelperHealthOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  perTryTimeoutMs?: number;
  /** See `CallBrokerMethodArgs.requireVerifiedIdentity`. */
  requireVerifiedIdentity?: boolean;
  expectedHelperIdentifiers?: readonly string[];
}

export declare function probeHelperHealth(
  socketPath: string,
  options?: ProbeHelperHealthOptions,
): Promise<HelperHealth>;

export interface SocketPathOptions {
  dir?: string;
  env?: Record<string, string | undefined>;
}

export declare function mintBrokerSocketPath(options?: SocketPathOptions): string;
export declare function resolveBrokerSocketPath(options?: SocketPathOptions): string;

export interface BrokerRequest {
  id?: string | null;
  method: string;
  params?: unknown;
}

export interface BrokerResponse {
  ok: boolean;
  [key: string]: unknown;
}

export declare function parseRequestLine(line: string): BrokerRequest | undefined;
export declare function okResponse(result: unknown): BrokerResponse;
export declare function errorResponse(message: string, options?: { code?: string }): BrokerResponse;
export declare function errorResponseFromException(error: unknown): BrokerResponse;
export declare function serializeResponse(response: BrokerResponse): string;

export type BrokerErrorCode = string;
export type BrokerMethod = string;
export type CuaHelperErrorCode = string;
export type NativeAutomationBackend = Record<string, unknown>;

export interface BrokerHandler {
  (params: unknown, context?: unknown): Promise<unknown>;
}

export declare function dispatchRequest(
  backend: NativeAutomationBackend,
  request: BrokerRequest,
): Promise<BrokerResponse>;
export declare function handleRequestLine(
  backend: NativeAutomationBackend,
  line: string,
): Promise<BrokerResponse>;

export declare function isBrokerMethod(method: string): method is BrokerMethod;
export declare function isReadOnlyBrokerMethod(method: string): boolean;

export type CuaPermissionState = "granted" | "stale" | "denied" | "unknown";

export interface CuaPermissionStatus {
  available?: true;
  platform?: string;
  /** Verified signing identifier of the Helper, not a self-reported bundle string. */
  grantOwner: string | null;
  owner?: { display_name?: string } | null;
  accessibility: CuaPermissionState;
  accessibility_probe_ok?: boolean;
  accessibilityProbeOk?: boolean;
  grantOwnerDisplayName?: string | null;
  screenRecording: CuaPermissionState;
  /**
   * Functional Screen Recording probe result. `true` only when a real capture returned non-blank
   * pixels; `false` means "the probe ran and did not succeed, or never ran" and must never be read
   * as "Screen Recording denied" — use `screenRecording` and `screenCaptureProbeState` for that.
   */
  screenCaptureProbeOk?: boolean;
  /**
   * Whether a functional capture probe ran at all: `ok`, `failed`, or `not_run`. This is the
   * discriminator that `screenCaptureProbeOk` alone cannot express.
   */
  screenCaptureProbeState?: "ok" | "failed" | "not_run";
  /** The raw `CGPreflightScreenCaptureAccess` readout, which is process-cached. */
  screenRecordingReadout?: {
    preflight: boolean | null;
    source: string;
    cached?: boolean;
    note?: string;
  };
  idle?: boolean;
  reason?: string;
}

export interface CuaPermissionStatusUnavailable {
  available: false;
  reason: string;
  idle?: boolean;
  grantOwnerDisplayName?: string | null;
}

export type CuaPermissionStatusResult = CuaPermissionStatus | CuaPermissionStatusUnavailable;

export interface CuaPermissionStatusQueryOptions {
  probeScreenCapture?: boolean;
  [key: string]: unknown;
}

export interface CuaPermissionRestartResult {
  ok: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface CuaPermissionRestartOptions {
  onboardingSessionId?: string;
  reason?: string;
  beforeFreshStart?: () => void;
  [key: string]: unknown;
}

export interface ICuaPermissionService {
  getStatus(
    workspacePath: string,
    workspaceIdentity?: string,
    options?: CuaPermissionStatusQueryOptions,
  ): Promise<CuaPermissionStatusResult>;
  restartHelper(
    workspacePath?: string,
    workspaceIdentity?: string,
    options?: CuaPermissionRestartOptions,
  ): Promise<CuaPermissionRestartResult>;
}
