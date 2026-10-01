export type NodeCapability = "computerUse" | "shell" | "files" | "git" | "longTasks" | "minecraft";

/**
 * A capability is advertised only when a sanctioned AceVra service for it is actually wired
 * into this node. M2C ships NO execution surface (no shell/file/git/computer service), so the
 * registry is empty and the node advertises nothing. An installed `git` binary is not a wired
 * service. Later milestones register providers here as they land.
 */
export interface WiredCapability {
  capability: NodeCapability;
  /** True only if the corresponding service is installed AND reachable by the runtime. */
  available(): boolean;
}
export const WIRED_CAPABILITIES: readonly WiredCapability[] = [];

export function deriveNodeCapabilities(
  wired: readonly WiredCapability[] = WIRED_CAPABILITIES,
): NodeCapability[] {
  return [...new Set(wired.filter((entry) => entry.available()).map((entry) => entry.capability))];
}
