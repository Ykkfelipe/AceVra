/** Pure, journal-compatible worker snapshot. The host applies it; the engine only persists it. */
export interface WorkerPolicy {
  profile: string;
  access: "read" | "write";
  modelSelection?: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  maxTurns?: number;
  permissionMode?: "auto" | "plan";
}
