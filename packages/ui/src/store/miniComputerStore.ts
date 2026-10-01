// M3: mini Computer 面板的呈现状态（仅 UI 偏好，绝不是 workspace 事实）。
//
// workspace 的真相只来自宿主投影（session view 的 `workspace` 段）；这里只保存“用户是否
// 隐藏了面板 / 是否展开”这类会话键控的呈现选择。按 sessionId 键控：Task A 的隐藏/展开
// 永不影响 Task B，切换任务时各面板互不泄漏。
import { create } from "zustand";

interface MiniComputerPresentationState {
  /** sessionId → 用户用 × 隐藏了该会话的面板（任务与执行不受影响）。 */
  hiddenBySession: Record<string, boolean>;
  /** sessionId → 面板处于展开呈现（同一 workspace，更大视图）。 */
  expandedBySession: Record<string, boolean>;
  hide: (sessionId: string) => void;
  reopen: (sessionId: string) => void;
  setExpanded: (sessionId: string, expanded: boolean) => void;
}

export const useMiniComputerStore = create<MiniComputerPresentationState>((set) => ({
  hiddenBySession: {},
  expandedBySession: {},
  hide: (sessionId) =>
    set((state) => ({
      hiddenBySession: { ...state.hiddenBySession, [sessionId]: true },
      // 隐藏面板同时收起展开层，重开后回到画中画形态。
      expandedBySession: { ...state.expandedBySession, [sessionId]: false },
    })),
  reopen: (sessionId) =>
    set((state) => ({
      hiddenBySession: { ...state.hiddenBySession, [sessionId]: false },
    })),
  setExpanded: (sessionId, expanded) =>
    set((state) => ({
      expandedBySession: { ...state.expandedBySession, [sessionId]: expanded },
    })),
}));
