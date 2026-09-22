import type { ZCodeConfigOption } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";

/** 从 Registry 的 ModelConfig Option Specs 读取思考档位。 */
export function resolveModelThoughtOption(params: {
  modelSelectionView: ModelSelectionView;
  providerId: string;
  modelId: string;
  currentValue?: string;
  formatLevelName?: (level: string) => string;
}): ZCodeConfigOption | null {
  const provider = params.modelSelectionView.providers.find(
    (candidate) => candidate.providerId === params.providerId,
  );
  const model = provider?.models.find((candidate) => candidate.modelId === params.modelId);
  const reasoning = model?.config.optionSpecs.reasoningLevel;
  if (!reasoning || reasoning.values.length === 0) return null;

  return {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    // Reasoning 没有默认档位；空字符串表示模型已选但用户尚未选择 reasoning。
    currentValue:
      params.currentValue && reasoning.values.includes(params.currentValue)
        ? params.currentValue
        : "",
    options: reasoning.values.map((level) => ({
      value: level,
      name: params.formatLevelName?.(level) ?? level,
    })),
  };
}

/**
 * 判断一份思考档位 Option 是否是“provider 托管 effort”的单一名义档：
 * values 只有一个且值恰为 "default"。这类模型没有真实档位阶梯，effort 由服务端自行决定，
 * 展示层应隐藏档位控件（否则用户会对着没有语义的 "default" 以为在调档）。
 * 原因：不能让 resolveModelThoughtOption 对这种情况返回 null —— OffPeakEditView 的
 * effectiveThoughtLevel/canSubmit 和 SubagentsSection 的 supported/unsupported 状态都
 * 依赖“Option 存在”这一事实，置空会把提交/保存按钮连坐禁用（已验证的两处回归）。
 * 因此解析契约不变，只在各渲染点用本谓词隐藏控件；currentValue 与提交语义保持原样。
 */
export function isProviderManagedThoughtOption(
  option: Pick<ZCodeConfigOption, "options"> | null | undefined,
): boolean {
  const entries = option?.options;
  return entries !== undefined && entries.length === 1 && entries[0]?.value === "default";
}
