export interface ComputerUseRuntimeContext {
  sessionId: string;
  runtimeScope: "main" | "subagent";
  workspaceKey: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  turnId?: string;
  clientMode?: "web-remote-replayable" | "desktop-continuous";
  deliveryKind?: "web-remote-replayable" | "desktop-continuous";
  trace?: Record<string, unknown>;
}

export interface ComputerUseRuntimeExecuteInput {
  toolName: string;
  arguments?: unknown;
  context: ComputerUseRuntimeContext;
  signal?: AbortSignal;
}

export interface ComputerUseRuntime {
  execute(input: ComputerUseRuntimeExecuteInput): Promise<unknown>;
  closeSession(context: ComputerUseRuntimeContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface ComputerUseRuntimeOptions {
  /** Runtime platform; injectable for deterministic capability tests. */
  platform?: string;
  /**
   * Hardened host-owned transport only: the per-launch session capability for the socket above.
   * Captured with the socket because the trusted plugin host clears it from the environment once
   * the stdio MCP server process has been created, while the broker client would otherwise read
   * it at call time and send every request without a capability.
   */
  brokerToken?: string;
  brokerSocketPath?: string;
  refreshMarkerPath?: string;
  ensureBrokerAvailable?: () => Promise<void>;
  /** Host-owned capability gate; MCP request metadata cannot enable foreground control. */
  allowForegroundControl?: () => boolean;
  env?: Record<string, string | undefined>;
  /**
   * Helper signing identifiers this runtime will accept. Defaults to the ids this repository
   * builds (see `broker.js`); an unknown identity is refused rather than trusted.
   */
  expectedHelperIdentifiers?: readonly string[];
  leaseAuthority?: {
    beginAcquire(owner: { session: string; task: string }): Promise<{ leaseId: string }>;
    commitAcquire(leaseId: string, helperRequirement: string): Promise<unknown>;
    stop(): Promise<unknown>;
    /** CUA-4: pause admission; when present, it gates every method except status reads. */
    admission?(): Promise<{ paused: boolean; pausedAt?: number }>;
    /** CUA-4: best-effort activity projection; never awaited by the action path. */
    reportActivity?(
      report: import("./lease-authority-client.js").ComputerUseActivityReport,
    ): Promise<unknown>;
  };
}

export {
  COMPUTER_USE_CLASSIFICATIONS,
  COMPUTER_USE_BACKEND_SUPPORT,
  COMPUTER_USE_CANONICAL_MODEL_PREFIX,
  COMPUTER_USE_ACTION_CLASSIFICATIONS,
  COMPUTER_USE_EFFECTS,
  COMPUTER_USE_METHODS,
  COMPUTER_USE_MODEL_TO_METHOD,
  COMPUTER_USE_MODEL_GUIDANCE,
  COMPUTER_USE_ROUTES,
  COMPUTER_USE_FOREGROUND_METHODS,
  normalizeComputerUseResult,
  canonicalComputerUseMcpName,
  resolveComputerUseCapabilities,
  resolveComputerUseMethod,
  validSemanticActionInput,
  validForegroundInput,
} from "./capability-contract.js";
export type {
  ComputerUseClassification,
  ComputerUseEffect,
  ComputerUseMethod,
} from "./capability-contract.js";

export declare function createComputerUseRuntime(
  options?: ComputerUseRuntimeOptions,
): ComputerUseRuntime;
