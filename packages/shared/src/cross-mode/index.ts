/**
 * Cross-Mode Continuity 契约入口 —— milestone 1「契约与边界」。
 *
 * 覆盖：稳定模式/对象 ID（modes）、统一错误码与校验问题（errors）、
 * 上下文选择与预览/编辑（context）、版本化 HandoffPacket（handoff-packet）、
 * 结果返回摘要（handoff-return）。
 *
 * 纯契约层：无 IO、无模式切换、无工作派发。Bot / Coding / Multitask / UI 的接入方
 * 消费本入口，不得复制或用本地逻辑放宽这里的校验与上限。
 */
export * from "./modes.js";
export * from "./errors.js";
export * from "./context.js";
export * from "./handoff-packet.js";
export * from "./handoff-return.js";

// M2（已准备）：预览会话与准入流程；执行端口与持久化是隔离的集成点，不含 Bot/Multitask 接线。
export * from "./flow-errors.js";
export * from "./ports.js";
export * from "./preview-session.js";
export * from "./admission.js";
