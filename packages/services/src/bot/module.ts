/**
 * bot 模块清单：Personal Bot 的身份/档案、对话指针、个人记忆与能力面声明。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts。
 */
export const botModule = {
  id: "bot",
  requires: ["shared", "services"],
  provides: ["bot-service"],
  publicEntrypoints: ["contract.ts"],
} as const;
