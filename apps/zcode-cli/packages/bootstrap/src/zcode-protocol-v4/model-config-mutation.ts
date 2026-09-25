import type { ModelSelection, TraceContext } from "@zcode/contracts";
import type { ZCodeApp } from "../app/types.js";

const modelConfigMutationTails = new WeakMap<ZCodeApp, Promise<void>>();

/**
 * 同一个 session App 的模型配置只有一个串行化临界区。
 *
 * provider registry fallback 与用户 `switchModelConfig` 过去分别直接调用
 * `setModel`，两条异步链可能交错成“后开始的目录兜底覆盖用户选择”，事件顺序也会与
 * runtime 最终值不一致。这里按 App 身份串行化所有模型/thought 变更；失败只结束本次
 * operation，不污染后续 tail。WeakMap 不延长 session 生命周期。
 */
export async function runSessionModelConfigMutation<T>(
  app: ZCodeApp,
  operation: () => Promise<T>,
): Promise<T> {
  const previousTail = modelConfigMutationTails.get(app) ?? Promise.resolve();
  const currentOperation = previousTail.catch(() => undefined).then(operation);
  const currentTail = currentOperation.then(
    () => undefined,
    () => undefined,
  );
  modelConfigMutationTails.set(app, currentTail);
  try {
    return await currentOperation;
  } finally {
    if (modelConfigMutationTails.get(app) === currentTail) {
      modelConfigMutationTails.delete(app);
    }
  }
}

function sameSelection(left: ModelSelection | undefined, right: ModelSelection): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

/**
 * 在回合之外切换 Session 模型，并发布与 v4 switchModelConfig 同形的 ModelSelected。
 * 调用方负责放进 runSessionModelConfigMutation 临界区。
 *
 * 修复：legacy `session/setModel`（后端迁移就绪确认、desktop 旧 session 服务）过去只改 runtime，
 * 不发 ModelSelected；v4 投影 config 停在旧模型，下一次 TurnStarted 用上一轮模型对比这份过期
 * config，画出方向相反的「Model switched」分隔线（见 specs/model-change-divider.md）。
 */
export async function applySessionModelSelection(
  app: ZCodeApp,
  selection: ModelSelection,
  traceContext: TraceContext,
): Promise<void> {
  const previous = app.runtime.getSessionModelSelection();
  await app.setModel(selection);
  const next = app.runtime.getSessionModelSelection();
  if (!next || sameSelection(previous, next)) return;
  const thought = app.getThoughtLevel();
  await app.runtime.emitModelSelected({
    modelSelection: next,
    ...(thought ? { effectiveReasoningLevel: thought } : {}),
    // 缺省 = 未知来源（不是显式 ∅→X 边界），不能传 null。
    ...(previous ? { previousModelSelection: previous } : {}),
    supportedThoughtLevels: app.listThoughtLevels(),
    traceContext,
  });
}
