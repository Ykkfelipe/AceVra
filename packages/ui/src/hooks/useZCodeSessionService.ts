import type { IZCodeSessionService } from "@zcode/services";
import { useResolvedServiceAccessor } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 不再按 workspacePath 二选一调用不同 hook（会让 hook 序列错位崩溃），统一走稳定的 resolution。
  return useResolvedServiceAccessor(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    .zcodeSessionService;
}

