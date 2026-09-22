import type { ICodexExecutionService } from "@zcode/services";
import { useResolvedServiceAccessor } from "@/hooks/useWorkspaceServices.js";

/**
 * Codex 执行后端服务（phase 10）。
 *
 * 旧 host 未注册该 descriptor 时 accessor 上为 undefined；调用方据此禁用 Codex
 * 后端入口。经此通道只能访问 v4 会话投影与脱敏任务绑定，没有凭证材料。
 */
export function useCodexExecutionService(): ICodexExecutionService | undefined {
  return useResolvedServiceAccessor(undefined, undefined, undefined).codexExecutionService;
}
