// 后端迁移服务的 attachment 作用域（backend-migration.md Amendment 4）。
// zcode 历史段读取与会话种子写入必须经过本 MessagePort 已握手的可信 Agent scope——
// 与 conversation share 同一原因：原始 Agent 服务会以 connection untrusted 拒绝 rows/range。
// 桌面与手机远控共用同一 Host attachment 与同一服务实例，不另起迁移状态。
import type { IBackendMigrationService, IZCodeAgentService } from "@zcode/services";
import { backendMigrationConnectionScopeFactory } from "@zcode/services/node";

type BackendMigrationAgentService = Pick<
  IZCodeAgentService,
  | "conversationRowsRangeV4"
  | "resumeSession"
  | "createSession"
  | "setModel"
  | "seedBackendHandoff"
  | "removeBackendHandoffSeed"
  | "generateWorkspaceText"
>;

type ConnectionScopableBackendMigrationService = IBackendMigrationService & {
  [backendMigrationConnectionScopeFactory](
    agentService: BackendMigrationAgentService,
  ): IBackendMigrationService;
};

function isConnectionScopable(
  service: IBackendMigrationService,
): service is ConnectionScopableBackendMigrationService {
  return (
    backendMigrationConnectionScopeFactory in service &&
    typeof (service as ConnectionScopableBackendMigrationService)[
      backendMigrationConnectionScopeFactory
    ] === "function"
  );
}

export function scopeBackendMigrationServiceForAttachment(
  service: IBackendMigrationService,
  agentService?: BackendMigrationAgentService,
): IBackendMigrationService {
  if (!agentService || !isConnectionScopable(service)) return service;
  return service[backendMigrationConnectionScopeFactory](agentService);
}
