import type {
  ComputerBackend,
  ComputerBackendCapabilities,
  ComputerExecuteContext,
  ComputerRouteClass,
} from "./computer-backend.js";

export interface AgentPointerSnapshot {
  x: number | null;
  y: number | null;
  target: {
    pid: number | string | null;
    role: string | null;
    strategy: string | null;
  } | null;
  updatedAt: number | null;
}

export interface ZeroStealRecord {
  before: { frontmost: number | string | null; cursor: { x: number; y: number } | null } | null;
  after: { frontmost: number | string | null; cursor: { x: number; y: number } | null } | null;
  frontmostUnchanged: boolean | null;
  cursorUnchanged: boolean | null;
}

export interface AgentWorkspacePerformResult {
  route: ComputerRouteClass;
  result: unknown;
  zeroSteal?: ZeroStealRecord;
}

export interface AgentWorkspaceBackend extends ComputerBackend {
  readonly agentPointer: AgentPointerSnapshot;
  /** M2B read model for the mini Computer view (pure snapshot; never captures). */
  projectionSnapshot(): import("./computer-workspace-projection.js").WorkspaceProjectionSnapshot;
  perform(
    method: string,
    args: Record<string, unknown>,
    context: ComputerExecuteContext,
  ): Promise<AgentWorkspacePerformResult>;
}

export declare function createAgentWorkspaceBackend(options: {
  execute: (input: { toolName: string; arguments: Record<string, unknown>; context: ComputerExecuteContext }) => Promise<unknown>;
  snapshot?: () => Promise<{ frontmost: number | string | null; cursor: { x: number; y: number } | null } | null>;
  projection?: import("./computer-workspace-projection.js").WorkspaceProjection;
}): AgentWorkspaceBackend;
