// M3: mini Computer 面板的呈现状态（仅 UI 偏好，绝不是 workspace 事实）。
//
// workspace 的真相只来自宿主投影（session view 的 `workspace` 段）与窗口流；这里只保存
// “隐藏 / 展开 / 浮窗位置与宽度 / Stop 后的收起时刻”这类会话键控的呈现选择。按 sessionId
// 键控：Task A 的呈现永不影响 Task B；未来的原生独立窗口可订阅同一会话、使用自己的条目。
import { create } from "zustand";

export interface MiniComputerPoint {
  x: number;
  y: number;
}

interface MiniComputerPresentationState {
  /** sessionId → 用户用 × 隐藏了该会话的面板（任务与执行不受影响）。 */
  hiddenBySession: Record<string, boolean>;
  /** sessionId → 面板处于展开呈现（同一 workspace，更大视图）。 */
  expandedBySession: Record<string, boolean>;
  /** sessionId → 用户拖动后的紧凑浮窗左上角（视口坐标）；未拖动时为默认锚点。 */
  positionBySession: Record<string, MiniComputerPoint>;
  /** sessionId → 用户调整后的紧凑浮窗宽度；高度由画面宽高比决定。 */
  widthBySession: Record<string, number>;
  /** sessionId → 用户按下 Stop 的时刻；短暂显示「已停止」后收起。 */
  stoppedAtBySession: Record<string, number>;
  hide: (sessionId: string) => void;
  reopen: (sessionId: string) => void;
  setExpanded: (sessionId: string, expanded: boolean) => void;
  setPosition: (sessionId: string, position: MiniComputerPoint) => void;
  setWidth: (sessionId: string, width: number) => void;
  markStopped: (sessionId: string, at: number) => void;
  clearStopped: (sessionId: string) => void;
}

export const useMiniComputerStore = create<MiniComputerPresentationState>((set) => ({
  hiddenBySession: {},
  expandedBySession: {},
  positionBySession: {},
  widthBySession: {},
  stoppedAtBySession: {},
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
  setPosition: (sessionId, position) =>
    set((state) => ({
      positionBySession: { ...state.positionBySession, [sessionId]: position },
    })),
  setWidth: (sessionId, width) =>
    set((state) => ({
      widthBySession: { ...state.widthBySession, [sessionId]: width },
    })),
  markStopped: (sessionId, at) =>
    set((state) => ({
      stoppedAtBySession: { ...state.stoppedAtBySession, [sessionId]: at },
      expandedBySession: { ...state.expandedBySession, [sessionId]: false },
    })),
  clearStopped: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.stoppedAtBySession)) return state;
      const next = { ...state.stoppedAtBySession };
      delete next[sessionId];
      return { stoppedAtBySession: next };
    }),
}));
