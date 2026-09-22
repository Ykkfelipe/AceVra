/**
 * codex 模块清单：Codex App Server 执行后端（thread 生命周期 + v4 会话投影 + 审批）。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 */
export const codexModule = {
  id: "codex",
  requires: ["shared", "services"],
  provides: ["codex-execution-service"],
  publicEntrypoints: ["contract.ts"],
} as const;
