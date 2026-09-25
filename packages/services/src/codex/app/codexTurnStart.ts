// 单轮 Codex turn 启动（app）：把「allow-list 覆盖 + turn/start + 原生 turn id 回填 +
// 状态持久化 + 失败本地收口」收在一处，让 ICodexExecutionService.sendTurn 只做栅栏与委派。
//
// turn/start 的 input 形状以 spec 的 E2E checklist 为准；响应携带 {turn:{id}}（schema）：
// 记下 Codex 侧 turn id 供 turn/interrupt 使用，并回填本轮 userInput/turnHeader 的
// sourceTurnId（Amendment 4：后端迁移据此在重建后仍能识别 handoff 轮）。
import { CODEX_METHODS } from "#src/codex/domain/codexWire.js";
import { scrubCodexErrorDetail } from "#src/codex/domain/codexWire.js";
import { createUuid } from "@zcode/shared";
import type { CodexProjectionCommit } from "#src/codex/domain/codexProjection.js";
import type { CodexModelOverride } from "#src/codex/domain/codexPolicy.js";
import { extractCodexTurnId } from "./codexTaskRuntime.js";
import type { CodexAppServerPort } from "./codexPorts.js";
import type { CodexTaskRuntime } from "./codexTaskRuntime.js";

/** 启动一轮 Codex turn；失败时本地把 turnHeader 收成 failed 并抛脱敏错误。 */
export async function startCodexTurn(input: {
  bridge: CodexAppServerPort;
  runtime: CodexTaskRuntime;
  params: { taskId: string; content: string; commandId?: string };
  override: CodexModelOverride;
  emitCommit(taskId: string, commit: CodexProjectionCommit): void;
  persistTurnOverride(runtime: CodexTaskRuntime, override: CodexModelOverride): void;
  persistStatus(taskId: string, status: "running" | "error"): void;
}): Promise<{ accepted: true; commandId: string }> {
  const { bridge, runtime, params, override, emitCommit, persistTurnOverride, persistStatus } =
    input;
  const commandId = params.commandId || createUuid();
  const turnId = `codex-turn-${++runtime.turnCounter}-${commandId.slice(0, 8)}`;
  const commit = runtime.projection.beginUserTurn({ text: params.content, turnId, commandId });
  emitCommit(params.taskId, commit);
  try {
    // turn/start 的 input 形状以 spec 的 E2E checklist 为准；文本项 {type:"text", text}。
    // 响应携带 {turn:{id}}（schema）：记下 Codex 侧 turn id 供 turn/interrupt 使用。
    const result = await bridge.call(CODEX_METHODS.turnStart, {
      threadId: runtime.codexThreadId,
      input: [{ type: "text", text: params.content }],
      ...(override.modelId ? { model: override.modelId } : {}),
      ...(override.effort ? { effort: override.effort } : {}),
    });
    runtime.codexTurnId = extractCodexTurnId(result);
    // 回填本轮 userInput/turnHeader 的 Codex 原生 turn id（sourceTurnId，Amendment 4）。
    const bound = runtime.codexTurnId
      ? runtime.projection.bindSourceTurnId(runtime.codexTurnId)
      : null;
    if (bound) emitCommit(params.taskId, bound);
    persistTurnOverride(runtime, override);
  } catch (error) {
    // Codex 不会为这次 turn 发 turn/completed；投影必须本地收口成 failed，
    // 否则 UI 停在幽灵 running 轮上（canStop 永真）。
    const message = error instanceof Error ? error.message : String(error);
    emitCommit(params.taskId, runtime.projection.failActiveTurn("codex.turnStartFailed", message));
    persistStatus(params.taskId, "error");
    throw new Error(scrubCodexErrorDetail(`codex_turn_start_failed: ${message}`));
  }
  persistStatus(params.taskId, "running");
  return { accepted: true, commandId };
}
