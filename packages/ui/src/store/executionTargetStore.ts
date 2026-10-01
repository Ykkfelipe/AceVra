// 对话 ↔ 电脑工作（任务）归属（仅渲染端呈现状态，绝不是任务事实）。
//
// 任务状态与事件的唯一事实源是控制面（节点任务）或 desktop main 的本地 runner；这里只记录
// “哪些任务是从这个对话发起的”。按执行 scope 键控：`session:<id>` 或 `draft:<workspaceKey>`，
// 对话之间互不泄漏。不持久化。agent 用哪台电脑由 agent 根据用户请求决定（见
// packages/desktop/specs/acevra-agent-computer.md），composer 不再有「Run on」选择。
import type { SubmissionExecutionTarget } from "@zcode/shared";
import { create } from "zustand";

export function executionScopeKey(
  workspace: { workspacePath: string; workspaceIdentity?: string },
  sessionId: string | null,
): string {
  if (sessionId) return `session:${sessionId}`;
  return `draft:${workspace.workspaceIdentity?.trim() || workspace.workspacePath}`;
}

interface ExecutionTargetState {
  /** scope → 从该对话发起的任务 id（只由发起任务的代码写入）。 */
  tasksByScope: Record<string, string[]>;
  /** 最近一次挂载 composer 的 scope；工程 runner 用它决定任务归属。 */
  activeScope: string | null;
  attachTask: (scope: string, taskId: string) => void;
  dismissTask: (scope: string, taskId: string) => void;
  noteActiveScope: (scope: string) => void;
  /** 草稿首发成为会话：草稿里的任务并入会话 scope（取并集去重保序），草稿复位。 */
  adoptDraft: (draftScope: string, sessionScope: string) => void;
}

export const useExecutionTargetStore = create<ExecutionTargetState>((set, get) => ({
  tasksByScope: {},
  activeScope: null,
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
  // Bug 原因：agent 启动的任务由 Main 推送挂到 `session:<id>`，可能早于草稿→会话的 adopt；
  // 旧实现“会话 scope 非空就整体放弃”，会丢掉草稿里的任务。
  // 修复依据：任务取并集去重保序；草稿随后清空，重复调用不会产生新变化（幂等）。
  adoptDraft: (draftScope, sessionScope) =>
    set((state) => {
      const draftTasks = state.tasksByScope[draftScope] ?? [];
      if (draftTasks.length === 0) return state;
      const { [draftScope]: _tasks, ...tasksByScope } = state.tasksByScope;
      const sessionTasks = tasksByScope[sessionScope] ?? [];
      tasksByScope[sessionScope] = [
        ...sessionTasks,
        ...draftTasks.filter((id) => !sessionTasks.includes(id)),
      ];
      return { tasksByScope };
    }),
}));

/**
 * 用户输入总是声明 `automatic`：composer 已没有电脑选择，Bash 在本机运行；用户点名另一台电脑
 * 时由 agent 通过 ExecutionTargets / RunOnTarget 完成。CLI 会话记录仍是绑定的唯一所有者，
 * 每轮显式声明 `automatic` 保证不会残留一个 UI 无法切回、导致 Bash 一直被拒绝的远端绑定。
 */
export const AUTOMATIC_SUBMISSION_TARGET: SubmissionExecutionTarget = Object.freeze({
  kind: "automatic",
});
