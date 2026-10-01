// M2E：对话级「Run on」选择与对话 ↔ 任务归属（仅渲染端呈现状态，绝不是任务事实）。
//
// 任务状态与事件的唯一事实源是控制面（节点任务）或 desktop main 的本地 runner；这里只记录
// “这个对话选了哪个执行目标”与“哪些任务是从这个对话发起的”。按执行 scope 键控：
// `session:<id>` 或 `draft:<workspaceKey>`，对话之间互不泄漏。不持久化（与草稿同级的偏好）。
import { create } from "zustand";

export const AUTO_TARGET = "auto";

export function executionScopeKey(
  workspace: { workspacePath: string; workspaceIdentity?: string },
  sessionId: string | null,
): string {
  if (sessionId) return `session:${sessionId}`;
  return `draft:${workspace.workspaceIdentity?.trim() || workspace.workspacePath}`;
}

interface ExecutionTargetState {
  /** scope → 选中的 ExecutionTarget id；缺省即 Automatic。 */
  selectionByScope: Record<string, string>;
  /** scope → 从该对话发起的任务 id（只由发起任务的代码写入）。 */
  tasksByScope: Record<string, string[]>;
  /** 最近一次挂载 composer 的 scope；工程 runner 用它决定任务归属。 */
  activeScope: string | null;
  selectionOf: (scope: string) => string;
  select: (scope: string, targetId: string) => void;
  attachTask: (scope: string, taskId: string) => void;
  dismissTask: (scope: string, taskId: string) => void;
  noteActiveScope: (scope: string) => void;
  /** 草稿首发成为会话：仅当会话 scope 为空时继承草稿的选择与任务，并把草稿复位。 */
  adoptDraft: (draftScope: string, sessionScope: string) => void;
}

export const useExecutionTargetStore = create<ExecutionTargetState>((set, get) => ({
  selectionByScope: {},
  tasksByScope: {},
  activeScope: null,
  selectionOf: (scope) => get().selectionByScope[scope] ?? AUTO_TARGET,
  select: (scope, targetId) =>
    set((state) => ({ selectionByScope: { ...state.selectionByScope, [scope]: targetId } })),
  attachTask: (scope, taskId) =>
    set((state) => {
      const current = state.tasksByScope[scope] ?? [];
      if (current.includes(taskId)) return state;
      return { tasksByScope: { ...state.tasksByScope, [scope]: [...current, taskId] } };
    }),
  dismissTask: (scope, taskId) =>
    set((state) => ({
      tasksByScope: {
        ...state.tasksByScope,
        [scope]: (state.tasksByScope[scope] ?? []).filter((id) => id !== taskId),
      },
    })),
  noteActiveScope: (scope) => {
    if (get().activeScope !== scope) set({ activeScope: scope });
  },
  adoptDraft: (draftScope, sessionScope) =>
    set((state) => {
      const sessionEmpty =
        state.selectionByScope[sessionScope] === undefined &&
        (state.tasksByScope[sessionScope] ?? []).length === 0;
      if (!sessionEmpty) return state;
      const selection = state.selectionByScope[draftScope];
      const tasks = state.tasksByScope[draftScope] ?? [];
      if (selection === undefined && tasks.length === 0) return state;
      const { [draftScope]: _selection, ...selectionByScope } = state.selectionByScope;
      const { [draftScope]: _tasks, ...tasksByScope } = state.tasksByScope;
      return {
        selectionByScope:
          selection === undefined
            ? selectionByScope
            : { ...selectionByScope, [sessionScope]: selection },
        tasksByScope:
          tasks.length === 0 ? tasksByScope : { ...tasksByScope, [sessionScope]: tasks },
      };
    }),
}));
