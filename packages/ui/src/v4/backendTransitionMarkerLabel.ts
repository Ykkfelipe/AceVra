// 迁移分隔线文案（纯函数）：端点名只来自持久化迁移记录的 backend/providerId，provider 显示名经
// 当前 registry 解析。记录本身是来源 provider 的唯一事实（backend-migration.md Amendment 5）。
import type { ZCodeExecutionBackend } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";

type MessageFormatter = Pick<IntlInstance, "formatMessage">;

export function formatBackendTransitionEndpoint(
  backend: ZCodeExecutionBackend,
  providerId: string | undefined,
  modelSelectionView: ModelSelectionView | null,
  intl: MessageFormatter,
): string {
  if (backend === "codex") return intl.formatMessage({ id: "chat.toolbar.backend.codex.label" });
  const agent = intl.formatMessage({ id: "chat.backendSwitch.agent" });
  const provider = resolveProviderLabel(providerId, modelSelectionView);
  return provider ? `${agent} · ${provider}` : agent;
}

export function formatBackendTransitionSwitchedLabel(
  marker: {
    readonly fromBackend: ZCodeExecutionBackend;
    readonly toBackend: ZCodeExecutionBackend;
    readonly fromProviderId?: string;
    readonly toProviderId?: string;
  },
  modelSelectionView: ModelSelectionView | null,
  intl: MessageFormatter,
): string {
  return intl.formatMessage(
    { id: "chat.backendTransition.switched" },
    {
      from: formatBackendTransitionEndpoint(
        marker.fromBackend,
        marker.fromProviderId,
        modelSelectionView,
        intl,
      ),
      to: formatBackendTransitionEndpoint(
        marker.toBackend,
        marker.toProviderId,
        modelSelectionView,
        intl,
      ),
    },
  );
}
