// 工具契约 → 能力动作的投影（native / MCP / 执行目标共用）。
import type { CapabilityAction, ModelToolContract } from "@zcode/contracts";

const MAX_ACTION_DESCRIPTION_CHARS = 240;

export function toolContractAction(contract: ModelToolContract): CapabilityAction {
  const description = contract.description?.split("\n")[0]?.trim();
  return {
    canonicalName: contract.name,
    invocation: { kind: "tool", toolName: contract.name },
    ...(description ? { description: description.slice(0, MAX_ACTION_DESCRIPTION_CHARS) } : {}),
    inputSchema: contract.inputSchema,
    availability: "available",
    risk: {
      readOnly: contract.readOnly === true,
      ...(contract.destructive === undefined ? {} : { destructive: contract.destructive }),
      ...(contract.sideEffectScope === undefined
        ? {}
        : { sideEffectScope: contract.sideEffectScope }),
      ...(contract.needsApproval === undefined ? {} : { needsApproval: contract.needsApproval }),
    },
  };
}
