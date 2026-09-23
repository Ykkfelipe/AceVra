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
  brokerSocketPath?: string;
  refreshMarkerPath?: string;
  ensureBrokerAvailable?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  /**
   * Helper signing identifiers this runtime will accept. Defaults to the ids this repository
   * builds (see `broker.js`); an unknown identity is refused rather than trusted.
   */
  expectedHelperIdentifiers?: readonly string[];
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
  normalizeComputerUseResult,
  canonicalComputerUseMcpName,
  resolveComputerUseCapabilities,
  resolveComputerUseMethod,
  validSemanticActionInput,
} from "./capability-contract.js";
export type {
  ComputerUseClassification,
  ComputerUseEffect,
  ComputerUseMethod,
} from "./capability-contract.js";

export declare function createComputerUseRuntime(
  options?: ComputerUseRuntimeOptions,
): ComputerUseRuntime;
