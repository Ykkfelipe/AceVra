import {
  getModelProviderFamilySpec,
  isZCodeAgentProvider,
  resolveModelProviderFamilySpecByProviderId,
  zcodeProviderAccountAccessSchema,
  type ZCodeProviderAccountAccess,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
}

function supportsRegistryApiFormat(
  selectedProvider: ZCodeProvider,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // 仅剩 glm（ZCode Agent）provider；三方 CLI 的 api format 差异已随 provider 下线。
  return isZCodeAgentProvider(selectedProvider);
}

/**
 * 当前 Provider 菜单选择对应的模型菜单范围：Z.ai family 展开成它的三个账号 provider id
 * （Individual/Start Plan/Team 三个分组都要看到）；某个已保存的个人 provider（如 Azure）
 * 只映射到它自己这一个 provider id；未选择时默认落回 Z.ai family，与 Provider 菜单的
 * 默认选中项保持一致。这里不做 family 白名单校验——Provider 菜单已经把 BigModel 等未启用
 * family 拦在外面，草稿不会带着那样的 provider id 走到这里。
 */
export function resolveModelSelectScopeProviderIds(
  currentProviderId: string | null | undefined,
): ReadonlySet<string> {
  const familySpec = currentProviderId
    ? resolveModelProviderFamilySpecByProviderId(currentProviderId)
    : undefined;
  if (familySpec) {
    return new Set([
      familySpec.individualCodingPlanProviderId,
      familySpec.startPlanProviderId,
      familySpec.teamCodingPlanProviderId,
    ]);
  }
  if (currentProviderId) {
    return new Set([currentProviderId]);
  }
  const zaiSpec = getModelProviderFamilySpec("zai");
  return new Set([
    zaiSpec.individualCodingPlanProviderId,
    zaiSpec.startPlanProviderId,
    zaiSpec.teamCodingPlanProviderId,
  ]);
}

export function buildRegistryModelSelectGroups(
  selectedProvider: ZCodeProvider,
  view: ModelSelectionView,
  labels: ModelProviderGroupLabelOptions = {},
  /** 省略 = 不按 provider 收窄（Settings/Subagent/Workflow 的「任选模型」场景）。 */
  scopeProviderIds?: ReadonlySet<string>,
): ModelSelectGroup[] {
  // 收窄到单个非 family provider 时，这是菜单里唯一的分组——没有别的 provider 需要
  // 靠子菜单区分，直接铺开模型（跟 Z.ai Individual/Start Plan 一样是平铺列表）。
  const forceDirectItems = scopeProviderIds !== undefined && scopeProviderIds.size === 1;
  return view.providers.flatMap((provider) => {
    if (scopeProviderIds && !scopeProviderIds.has(provider.providerId)) {
      return [];
    }
    if (!supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {
      return [];
    }

    const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    const accountPresentation = accountAccess.success
      ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
      : null;

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label: accountPresentation?.label || provider.providerName?.trim() || provider.providerId,
        ...(accountPresentation?.labelBadge ? { labelBadge: accountPresentation.labelBadge } : {}),
        ...(accountPresentation || forceDirectItems ? { directItems: true } : {}),
        items: provider.models.map(({ modelId, config }) => ({
          key: `registry-provider:${provider.providerId}:${modelId}`,
          value: encodeCustomModelValue(provider.providerId, modelId),
          name: modelId,
          ...(shouldShowModelVisionBadge(
            modelId,
            config.properties?.inputFormat?.supportsImage,
            provider.config.access,
          )
            ? { supportsVisionInput: true }
            : {}),
        })),
      },
    ];
  });
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  access: ZCodeProviderAccountAccess,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  const label = familySpec?.label ?? providerId;
  if (access.mode === "start-plan") {
    return { label: "Start Plan", labelBadge: labels.startPlanBadgeLabel ?? "Free" };
  }
  if (access.mode === "team-coding-plan") {
    return { label, labelBadge: labels.teamPlanBadgeLabel ?? "Team" };
  }
  return { label, labelBadge: labels.codingPlanBadgeLabel ?? "Individual" };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
