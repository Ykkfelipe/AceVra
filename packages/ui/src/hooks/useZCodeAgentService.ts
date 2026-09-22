import type { IZCodeAgentService } from "@zcode/services";
import { useResolvedServiceAccessor } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // 统一走稳定的 resolution，避免按 workspacePath 二选一调用不同 hook 导致序列错位崩溃。
  return useResolvedServiceAccessor(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    .zcodeAgentService;
}

