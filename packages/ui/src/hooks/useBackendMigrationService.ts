import type { IBackendMigrationService } from "@zcode/services";
import { useResolvedServiceAccessor } from "@/hooks/useWorkspaceServices.js";

/**
 * 后端迁移服务（phase 11，backend-migration.md Amendment 4）。
 *
 * 旧 host 未注册该 descriptor 时为 undefined；调用方据此隐藏跨后端切换入口。
 * UI 只能经它发起「切换执行后端」这一个写操作，并观察持久化结果。
 */
export function useBackendMigrationService(): IBackendMigrationService | undefined {
  return useResolvedServiceAccessor(undefined, undefined, undefined).backendMigrationService;
}
