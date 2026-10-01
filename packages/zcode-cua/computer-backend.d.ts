import type { ComputerUseMethod } from "./capability-contract.js";

/** Broker-level method names accepted by backends (values of COMPUTER_USE_MODEL_TO_METHOD). */
export type ComputerBackendMethod = ComputerUseMethod;

/** How disruptive an operation class is for the user's own foreground. */
export type ComputerMethodClass = "background" | "physical" | "lease";

/** Route classes reported to callers. `background` is a hard focus-safety promise. */
export type ComputerRouteClass = "background" | "workspace" | "foreground";

/** Truthful per-backend capability report; never fabricated. */
export interface ComputerBackendCapabilities {
  id: string;
  observes: boolean;
  /** Semantic mutation (press / set_value) without disturbing the user's foreground. */
  backgroundSemanticMutation: boolean;
  /** Can drive pointer input on its own surface (agent-owned workspace). */
  independentPointer: boolean;
  /** Can synthesize keyboard input on its own surface. */
  independentTextInput: boolean;
  /** Owns a separate foreground (virtual display / workspace) for synthesis targets. */
  ownsForegroundWorkspace: boolean;
  /** Requires the user's real foreground to deliver physical input (native behavior). */
  requiresUserForegroundForPhysicalInput: boolean;
  /** Can provide a live/recent frame stream for a mini view. */
  frameStream: boolean;
}

/** Execution context forwarded to the sanctioned runtime seam (routing data, no credentials). */
export type ComputerExecuteContext = Record<string, unknown>;

export interface ComputerExecuteInput {
  toolName: string;
  arguments: Record<string, unknown>;
  context: ComputerExecuteContext;
}

export interface ComputerPerformResult {
  route: ComputerRouteClass;
  result: unknown;
}

export interface ComputerBackend {
  readonly capabilities: ComputerBackendCapabilities;
  perform(
    method: ComputerBackendMethod,
    args: Record<string, unknown>,
    context: ComputerExecuteContext,
  ): Promise<ComputerPerformResult>;
}

export interface ComputerRouteDecision {
  backend: ComputerBackend;
  routeClass: ComputerRouteClass;
}

export interface ComputerRoutedPerformResult {
  routeClass: ComputerRouteClass;
  backendId: string;
  result: unknown;
}

export declare function normalizeBackendCapabilities(
  capabilities: ComputerBackendCapabilities,
): Readonly<ComputerBackendCapabilities>;

export declare function routeClassFor(
  method: ComputerBackendMethod,
  capabilities: ComputerBackendCapabilities,
): ComputerRouteClass;

/**
 * Wrap the existing native runtime (its sanctioned
 * `execute({ toolName, arguments, context })` seam) as the native macOS backend.
 * Behavior-preserving by construction: identical dispatch, identical envelopes.
 */
export declare function createNativeMacBackend(options: {
  execute: (input: ComputerExecuteInput) => Promise<unknown>;
}): ComputerBackend;

export declare function createComputerBackendRouter(options: { backends: ComputerBackend[] }): {
  routeFor(method: ComputerBackendMethod): ComputerRouteDecision;
  perform(
    method: ComputerBackendMethod,
    args: Record<string, unknown>,
    context: ComputerExecuteContext,
  ): Promise<ComputerRoutedPerformResult>;
};
