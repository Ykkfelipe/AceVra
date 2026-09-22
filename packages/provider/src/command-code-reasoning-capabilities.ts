/**
 * Reviewed GOAT capability manifest for Command Code's managed Provider API.
 *
 * This is deliberately an exact allow-list, not a family matcher: the gateway's public
 * transport is shared, while selectable levels are model-specific product capability.
 */
export const COMMAND_CODE_REASONING_EFFORT_MAP = '{"reasoning_effort": reasoningLevel}' as const;

export interface CommandCodeReasoningCapability {
  readonly modelId: string;
  readonly reasoningLevels: readonly string[];
}

export const COMMAND_CODE_GOAT_REASONING_CAPABILITIES = [
  { modelId: "gpt-5.6-sol", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
  { modelId: "gpt-5.6-luna", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
  { modelId: "deepseek/deepseek-v4-pro", reasoningLevels: ["high", "max"] },
  { modelId: "deepseek/deepseek-v4-flash", reasoningLevels: ["high", "max"] },
  { modelId: "deepseek/deepseek-v4-flash-vision-exp", reasoningLevels: ["high", "max"] },
  { modelId: "deepseek/deepseek-v4-flash-fast", reasoningLevels: ["low", "high", "max"] },
  { modelId: "deepseek/deepseek-v4.1-flash", reasoningLevels: ["low", "high", "max"] },
  { modelId: "moonshotai/Kimi-K3", reasoningLevels: ["low", "high", "max"] },
  { modelId: "z-ai/glm-5.3-flash", reasoningLevels: ["low", "high", "max"] },
  { modelId: "z-ai/glm-5.3-flashx", reasoningLevels: ["low", "high", "max"] },
  { modelId: "zai-org/GLM-5.3", reasoningLevels: ["low", "high", "max"] },
  { modelId: "zai-org/GLM-5.2", reasoningLevels: ["high", "max"] },
  { modelId: "MiniMaxAI/MiniMax-M3", reasoningLevels: ["low", "medium", "high"] },
  { modelId: "Qwen/Qwen3.8-Omni-Flash", reasoningLevels: ["low", "medium", "xhigh"] },
  { modelId: "Qwen/Qwen3.8-Max-0902", reasoningLevels: ["low", "medium", "xhigh"] },
  { modelId: "Qwen/Qwen3.8-Max", reasoningLevels: ["low", "medium", "xhigh"] },
  { modelId: "Qwen/Qwen3.8-27B", reasoningLevels: ["low", "medium", "xhigh"] },
  { modelId: "Qwen/Qwen3.8-Flash", reasoningLevels: ["low", "medium", "xhigh"] },
  { modelId: "stepfun/Step-5-Preview", reasoningLevels: ["low", "medium", "high"] },
  { modelId: "tencent/hy4-preview", reasoningLevels: ["low", "medium", "high"] },
  { modelId: "google/gemini-3.8-flash", reasoningLevels: ["low", "medium", "high"] },
  { modelId: "google/gemini-3.7-flash", reasoningLevels: ["low", "medium", "high"] },
  { modelId: "meta/muse-spark-1.2", reasoningLevels: ["low", "medium", "high", "xhigh"] },
  {
    modelId: "meta/muse-spark-1.2-contributor",
    reasoningLevels: ["low", "medium", "high", "xhigh"],
  },
  {
    modelId: "meta/muse-spark-1.3-contributor",
    reasoningLevels: ["low", "medium", "high", "xhigh"],
  },
  { modelId: "meta/muse-spark-1.3", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
  { modelId: "xai/grok-4.5", reasoningLevels: ["low", "medium", "high"] },
  { modelId: "xai/grok-4.6", reasoningLevels: ["low", "medium", "high", "xhigh"] },
  { modelId: "xai/grok-4.7", reasoningLevels: ["low", "medium", "high", "xhigh"] },
] as const satisfies readonly CommandCodeReasoningCapability[];

export function commandCodeReasoningCapability(
  modelId: string,
): CommandCodeReasoningCapability | undefined {
  return COMMAND_CODE_GOAT_REASONING_CAPABILITIES.find((entry) => entry.modelId === modelId);
}

/**
 * Applies only the manifest-owned option spec to an encoded personal provider configuration.
 * The file repository remains responsible for validation and atomic persistence.
 */
export function applyCommandCodeReasoningCapabilitiesToPersonalConfig(input: unknown): unknown {
  const root = record(input, "provider config");
  const config = record(root.config, "provider config.config");
  const providerRules = record(config.providerConfigRules, "providerConfigRules");
  const modelRules = record(config.modelConfigRules, "modelConfigRules");
  const providers = array(providerRules.providerRules, "providerRules");
  const rules = array(modelRules.providerModelRules, "providerModelRules");

  const provider = providers.find(
    (entry) => record(entry, "provider rule").providerId === "command-code",
  );
  if (!provider) throw new Error("Command Code provider is not configured");

  const capabilityByModel: ReadonlyMap<string, CommandCodeReasoningCapability> = new Map(
    COMMAND_CODE_GOAT_REASONING_CAPABILITIES.map((entry) => [entry.modelId, entry]),
  );
  const found = new Set<string>();
  const nextRules = rules.map((entry) => {
    const rule = record(entry, "provider model rule");
    if (rule.providerId !== "command-code" || typeof rule.modelId !== "string") return rule;
    const capability = capabilityByModel.get(rule.modelId);
    if (!capability) return rule;
    found.add(capability.modelId);
    const modelConfig = record(rule.config, `model config for ${capability.modelId}`);
    const optionSpecs = record(modelConfig.optionSpecs, `option specs for ${capability.modelId}`);
    return {
      ...rule,
      config: {
        ...modelConfig,
        optionSpecs: {
          ...optionSpecs,
          reasoningLevel: {
            values: [...capability.reasoningLevels],
            map: COMMAND_CODE_REASONING_EFFORT_MAP,
          },
        },
      },
    };
  });

  const missing = COMMAND_CODE_GOAT_REASONING_CAPABILITIES.filter(
    (entry) => !found.has(entry.modelId),
  ).map((entry) => entry.modelId);
  if (missing.length > 0) {
    throw new Error(`Command Code capability rules are missing: ${missing.join(", ")}`);
  }

  return {
    ...root,
    config: {
      ...config,
      modelConfigRules: { ...modelRules, providerModelRules: nextRules },
    },
  };
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function array(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  return input;
}
