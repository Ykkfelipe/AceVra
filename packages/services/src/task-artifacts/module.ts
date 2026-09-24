/** task-artifacts module manifest; behavior remains behind contract.ts. */
export const taskArtifactsModule = {
  id: "task-artifacts",
  requires: ["shared", "services"],
  provides: ["task-artifact-service"],
  publicEntrypoints: ["contract.ts"],
} as const;
