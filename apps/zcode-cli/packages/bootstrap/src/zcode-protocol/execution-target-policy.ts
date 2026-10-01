import { zcodeWorkspaceUpdateExecutionTargetPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * M2F：执行目标工具面门禁（Desktop host 有 executor && 本地 workspace）是 workspace 级事实，
 * 与 Off-Peak 同一同步模式。只影响之后创建/恢复的 record；缺省 false（fail-closed）。
 */
export async function updateExecutionTargetPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateExecutionTargetPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.executionTargetsEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
