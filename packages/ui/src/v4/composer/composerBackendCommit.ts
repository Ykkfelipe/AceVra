import { parseModelPickerValue, type ModelSelection, type TaskTimelineView } from "@zcode/shared";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

/**
 * 已有 task 的已提交后端布局（backend-migration.md Amendment 5）。agentModelSelection 只在 live 段是
 * 由一次已提交迁移打开的 Agent 段、且那条记录带有完整目标选择时存在。
 */
export interface ComposerCommittedBackend {
  readonly layoutVersion: number;
  readonly agentModelSelection?: ModelSelection;
}

function parseCommittedSelection(value: string | undefined): ModelSelection | undefined {
  if (!value?.trim()) return undefined;
  try {
    return parseModelPickerValue(value);
  } catch {
    return undefined;
  }
}

/** 持久化时间线视图 → composer 需要的已提交事实；视图未知时返回 null（不做任何投影）。 */
export function resolveComposerCommittedBackend(
  view: TaskTimelineView | null | undefined,
): ComposerCommittedBackend | null {
  if (!view) return null;
  const live = view.segments.find((segment) => segment.live);
  const opening =
    live?.openedByTransitionIndex === undefined
      ? undefined
      : view.transitions.find((transition) => transition.index === live.openedByTransitionIndex);
  const agentModelSelection =
    view.executionBackend === "zcode" &&
    live?.backend === "zcode" &&
    opening?.status === "committed" &&
    opening.to === "zcode"
      ? parseCommittedSelection(opening.toModelSelection)
      : undefined;
  return {
    layoutVersion: view.layoutVersion,
    ...(agentModelSelection ? { agentModelSelection } : {}),
  };
}

/**
 * 修复：Codex → Agent 迁移提交后，已有 task 的草稿仍持有迁移前的 provider（草稿只在首次初始化时
 * 从会话取种子）。下一轮提交携带旧选择，runtime 被改回旧 provider，任务行随之记录旧 provider，
 * 后续迁移标记的来源 provider 也跟着错。已提交布局变化是一次性的权威事实：按提交的目标选择
 * 重新投影一次，并记下布局，重复快照不会再次覆盖之后的手动改选。
 *
 * 没有记录布局的草稿由当前会话配置初始化（不比已提交布局旧），只采纳布局、不改选择。
 */
export function applyComposerBackendCommit(
  draft: V4ComposerDraft,
  committed: ComposerCommittedBackend | null | undefined,
): V4ComposerDraft {
  if (!committed || draft.backendLayoutVersion === committed.layoutVersion) return draft;
  if (draft.backendLayoutVersion === undefined || !committed.agentModelSelection) {
    return { ...draft, backendLayoutVersion: committed.layoutVersion };
  }
  return {
    ...draft,
    modelSelection: committed.agentModelSelection,
    backendLayoutVersion: committed.layoutVersion,
  };
}
