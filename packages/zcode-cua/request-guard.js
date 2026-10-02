// Runtime execute() 前置校验（从 index.js 抽出以守住单文件行数边界；行为逐字保持一致）：
// 平台门、方法解析、参数形状与前台可用性都发生在触达 Helper 之前，拒绝即返回，
// 绝不把无效请求发给已验证的 Helper。
import {
  resolveComputerUseMethod,
  validSemanticActionInput,
  validOpenAppInput,
  validForegroundInput,
  COMPUTER_USE_FOREGROUND_METHODS,
} from "./capability-contract.js";
import { argsRefusal, foregroundComputerUseAvailable, MODEL_TOOL_HINT } from "./computer-surface.js";

/**
 * 校验一个非 describe 的 execute 请求。
 * 返回 null（通过，附带解析出的 method/foreground）或 { refusal }。
 */
export function validateComputerUseRequest({ toolName, input, platform, allowForegroundControl }) {
  const refusal = (text, code) => ({ refusal: { text, code } });
  const method = resolveComputerUseMethod(toolName);
  if (platform !== "darwin") {
    return refusal(
      "Computer Use native methods are unavailable on this platform",
      "unsupported_platform",
    );
  }
  if (!method) {
    return refusal(
      `Computer Use tool '${toolName || "(unnamed)"}' is not available: ${MODEL_TOOL_HINT}`,
      "unsupported",
    );
  }
  if (
    ((method === "press" || method === "set_value") &&
      !validSemanticActionInput(method, input?.arguments)) ||
    (method === "open_app" && !validOpenAppInput(input?.arguments))
  ) {
    return refusal(argsRefusal(toolName, method), "bad_request");
  }
  const foreground = COMPUTER_USE_FOREGROUND_METHODS.includes(method);
  if (
    method === "control_status" &&
    (!input?.arguments ||
      Object.keys(input.arguments).length !== 1 ||
      // Helper 签发的 lease id 是大写 UUID；大小写不敏感校验，原样透传（Helper 侧
      // 租约登记按原样字符串精确匹配，归一化反而会破坏后续 release/中断匹配）。
      !/^[0-9a-f-]{36}$/iu.test(input.arguments.lease_id ?? ""))
  ) {
    return refusal("control_status requires a lease_id", "bad_request");
  }
  if (foreground) {
    if (!foregroundComputerUseAvailable(input?.context, allowForegroundControl)) {
      return refusal(
        "Foreground Computer Use requires a local desktop task; background tools still work (see `await agent.computerUse.describe()`)",
        "local_only",
      );
    }
    if (!validForegroundInput(method, input?.arguments)) {
      return refusal(argsRefusal(toolName, method), "bad_request");
    }
  }
  return { method, foreground };
}
