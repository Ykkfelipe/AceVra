/**
 * Cross-Mode 来源回链（docs/specs/cross-mode-bot-to-coding.md §2 第 5 步）。
 *
 * v4 会话面只知道 `snapshot.crossModeOrigin`，不认识 Bot；「回到来源」由来源侧的所有者注入
 * （Bot：BotWorkspaceProvider，它持有对话选择的唯一写入路径）。本模块只定义能力的形状，
 * 不保存任何状态，也不依赖任何模式的实现。
 */
import { createContext, useContext } from "react";
import type { CrossModeOriginState } from "@zcode/shared/zcode-protocol-v4";

export interface CrossModeOriginNavigation {
  /** 来源可回链时返回 true；调用方据此决定是否显示动作。 */
  canOpenOrigin: (origin: CrossModeOriginState) => boolean;
  openOrigin: (origin: CrossModeOriginState) => void;
}

export const CrossModeOriginNavigationContext = createContext<CrossModeOriginNavigation | null>(
  null,
);

/** 来源 Bot 对话 id（契约 conversation 引用）；不是 Bot 来源时为 null。 */
export function botConversationIdOfOrigin(origin: CrossModeOriginState): string | null {
  if (origin.sourceMode !== "bot") return null;
  return origin.sourceRefs.find((ref) => ref.kind === "conversation")?.id ?? null;
}

/** 无 provider（Web、远程或测试环境）时返回 null：来源仍会展示，只是没有回链动作。 */
export function useCrossModeOriginNavigation(): CrossModeOriginNavigation | null {
  return useContext(CrossModeOriginNavigationContext);
}
