// M2E：对话级「Run on」选择与对话 ↔ 任务归属（仅渲染端呈现状态，绝不是任务事实）。
//
// 任务状态与事件的唯一事实源是控制面（节点任务）或 desktop main 的本地 runner；这里只记录
// “这个对话选了哪个执行目标”与“哪些任务是从这个对话发起的”。按执行 scope 键控：
// `session:<id>` 或 `draft:<workspaceKey>`，对话之间互不泄漏。不持久化（与草稿同级的偏好）。
import type { ExecutionTarget, SubmissionExecutionTarget } from "@zcode/shared";
import { create } from "zustand";

export const AUTO_TARGET = "auto";

export function executionScopeKey(
  workspace: { workspacePath: string; workspaceIdentity?: string },
  sessionId: string | null,
): string {
  if (sessionId) return `session:${sessionId}`;
  return `draft:${workspace.workspaceIdentity?.trim() || workspace.workspacePath}`;
}

export interface KnownExecutionTarget {
  displayName: string;
  isThisDevice: boolean;
}

interface ExecutionTargetState {
  /** scope → 选中的 ExecutionTarget id；缺省即 Automatic。 */
  selectionByScope: Record<string, string>;
  /** scope → 从该对话发起的任务 id（只由发起任务的代码写入）。 */
  tasksByScope: Record<string, string[]>;
  /** 最近一次挂载 composer 的 scope；工程 runner 用它决定任务归属。 */
  activeScope: string | null;
  /** 最近一次读到的目标名称/是否本机，仅用于发送时把选择翻译成线协议，不是可用性事实。 */
  knownTargets: Record<string, KnownExecutionTarget>;
  selectionOf: (scope: string) => string;
  select: (scope: string, targetId: string) => void;
  attachTask: (scope: string, taskId: string) => void;
  dismissTask: (scope: string, taskId: string) => void;
  noteActiveScope: (scope: string) => void;
  rememberTargets: (targets: readonly ExecutionTarget[]) => void;
  /** 草稿首发成为会话：合并进会话 scope（会话已有的显式选择优先，任务取并集），并把草稿复位。 */
  adoptDraft: (draftScope: string, sessionScope: string) => void;
}

export const useExecutionTargetStore = create<ExecutionTargetState>((set, get) => ({
  selectionByScope: {},
  tasksByScope: {},
  activeScope: null,
  knownTargets: {},
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
  rememberTargets: (targets) =>
    set((state) => {
      const knownTargets = { ...state.knownTargets };
      for (const target of targets) {
        knownTargets[target.id] = {
          displayName: target.displayName,
          isThisDevice: target.isThisDevice,
        };
      }
      return { knownTargets };
    }),
  // Bug 原因：M2F 起 agent 启动的任务由 Main 推送挂到 `session:<id>`，可能早于草稿→会话的
  // adopt；旧实现“会话 scope 非空就整体放弃”，会丢掉草稿里的 Run-on 选择与任务。
  // 修复依据：按字段合并——会话已有显式选择时保留，否则继承草稿选择；任务取并集去重保序。
  // 草稿随后复位为 Automatic 且无任务，重复调用不会产生新变化（幂等）。
  adoptDraft: (draftScope, sessionScope) =>
    set((state) => {
      const draftSelection = state.selectionByScope[draftScope];
      const draftTasks = state.tasksByScope[draftScope] ?? [];
      if (draftSelection === undefined && draftTasks.length === 0) return state;
      const { [draftScope]: _selection, ...selectionByScope } = state.selectionByScope;
      const { [draftScope]: _tasks, ...tasksByScope } = state.tasksByScope;
      if (draftSelection !== undefined && selectionByScope[sessionScope] === undefined) {
        selectionByScope[sessionScope] = draftSelection;
      }
      if (draftTasks.length > 0) {
        const sessionTasks = tasksByScope[sessionScope] ?? [];
        tasksByScope[sessionScope] = [
          ...sessionTasks,
          ...draftTasks.filter((id) => !sessionTasks.includes(id)),
        ];
      }
      return { selectionByScope, tasksByScope };
    }),
}));

const MAX_TARGET_DISPLAY_NAME = 120;

/**
 * 把 Run-on 选择翻译成 v4 `executionTarget`：Automatic 与本机都是 `automatic`（Bash 照旧本地），
 * 只有远端节点才是 `target`。未知 id 也如实发送 `target`，由 CLI/Main 真实拒绝，绝不静默回落本机。
 */
export function resolveSubmissionExecutionTarget(
  selection: string,
  known: Record<string, KnownExecutionTarget>,
): SubmissionExecutionTarget {
  if (selection === AUTO_TARGET) return { kind: "automatic" };
  const target = known[selection];
  if (!target) return { kind: "target", targetId: selection };
  if (target.isThisDevice) return { kind: "automatic" };
  const displayName = target.displayName.trim().slice(0, MAX_TARGET_DISPLAY_NAME).trim();
  return displayName
    ? { kind: "target", targetId: selection, displayName }
    : { kind: "target", targetId: selection };
}
