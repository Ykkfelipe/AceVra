// 「Model switched X → Y」分隔线文案（纯函数）。方向只来自 marker 自身的 from/to 字段，
// 不按行顺序或「当前 vs 上一个」推断（apps/zcode-cli/packages/bootstrap/specs/model-change-divider.md）。
import type { ModelSelectionView } from "@zcode/services";
import type { TimelineMarkerRow } from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";

type ModelChangeMarker = Extract<TimelineMarkerRow["marker"], { type: "modelChange" }>;

export interface ModelChangeMarkerLabel {
  /** source-less 是首次使用的模型事实（「Using X」），不是切换，不画切换箭头。 */
  readonly sourceLess: boolean;
  readonly label: string;
}

export function formatModelChangeMarkerLabel(
  marker: ModelChangeMarker,
  modelSelectionView: ModelSelectionView | null,
  intl: Pick<IntlInstance, "formatMessage">,
): ModelChangeMarkerLabel {
  // marker 已携带完整 provider/model 元组；provider 名随当前目录解析，保留 provider ID fallback。
  const toProvider = resolveProviderLabel(marker.toProvider, modelSelectionView);
  const to = formatModelChangeLabel(marker.toProvider, toProvider, marker.toModel, intl);
  if (marker.fromProvider === undefined || marker.fromModel === undefined) {
    return {
      sourceLess: true,
      label: intl.formatMessage({ id: "chat.modelChange.using" }, { model: to }),
    };
  }
  const fromProvider = resolveProviderLabel(marker.fromProvider, modelSelectionView);
  return {
    sourceLess: false,
    label: intl.formatMessage(
      { id: "chat.modelChange.switched" },
      {
        from: formatModelChangeLabel(marker.fromProvider, fromProvider, marker.fromModel, intl),
        to,
      },
    ),
  };
}
