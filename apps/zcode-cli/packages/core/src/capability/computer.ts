// 本机 Computer 能力投影：唯一数据源是 @zcode/zcode-cua 的 COMPUTER_USE_SURFACE /
// COMPUTER_USE_LIMITS（facade 可枚举键、describe() 与拒绝提示共用的同一张表）。
// 这里不复制方法名，只把它投影成 Capability；可用性谓词与 CUA runtime 一致。
import type { Capability, CapabilityAction } from "@zcode/contracts";
import {
  COMPUTER_USE_LIMITS,
  COMPUTER_USE_COMPAT_ALIASES,
  COMPUTER_USE_SURFACE,
  type ComputerUseSurfaceEntry,
} from "@zcode/zcode-cua/computer-surface";
import { THIS_DEVICE_TARGET } from "./domains.js";

export const COMPUTER_CAPABILITY_ID = "computer.local";
export const COMPUTER_MCP_PREFIX = "mcp__computer-use__";

/** 前台接管只在本机桌面主会话可请求（远程/手机不可）；原因逐字给模型。 */
export const PROTECTED_FOREGROUND_REASON =
  "screen takeover is only available in a desktop conversation on this Mac (not remote, mobile or replayed sessions); use the background actions instead";

/**
 * 被猜的前台/历史拼写 → 本会话真正可用的后台替代动作。
 * 修复依据（实测）：模型在 type_text / key_press / computer.press 等拼写上反复试错数分钟；
 * 结构化错误直接给出替代动作，一步改对。
 */
export const COMPUTER_FOREGROUND_ALTERNATIVES: Readonly<Record<string, readonly string[]>> = {
  "computer.type_text": ["computer.workspace_type_text", "computer.set_value"],
  "computer.key_press": ["computer.workspace_confirm"],
  "computer.click": ["computer.workspace_click", "computer.press"],
  "computer.scroll": ["computer.workspace_scroll"],
  "computer.activate_target": ["computer.open_app"],
  "computer.move_pointer": [],
  "computer.drag": [],
  "computer.acquire_control": [],
  "computer.release_control": [],
};

export interface ComputerCapabilitySource {
  /** runtimeFeatures.computerUse：官方插件已启用（只代表插件态，不代表 Helper 已连接）。 */
  featureEnabled: boolean;
  /** 生产者可读取时提供物理连接状态；未连接不等于无法按需启动。 */
  helperConnected?: boolean;
  /** Host 已验证并配置可按需恢复的传输；不从插件 enabled 推断。 */
  helperLazyStartable?: boolean;
  /** 模型可见的 node_repl 工具名（core `js` 或 MCP 宿主的 `mcp__node_repl__js`）；缺席即无执行面。 */
  nodeReplToolName?: string;
  platform: string;
  runtimeScope: "main" | "subagent";
  /** 与 foregroundComputerUseAvailable 同一谓词的结果；由本地桌面主会话门控。 */
  foregroundAvailable: boolean;
  /** 已注册的官方 CUA MCP 工具名（经可信门投影成 mcp__computer-use__*）。 */
  registeredToolNames: ReadonlySet<string>;
}

export function computerMcpToolName(surfaceName: string): string {
  return `${COMPUTER_MCP_PREFIX}${surfaceName.replace(/[^a-zA-Z0-9_-]/gu, "_")}`;
}

function capabilityUnavailableReason(source: ComputerCapabilitySource): string | undefined {
  if (source.platform !== "darwin") {
    return `Computer Use controls native macOS apps; this host is ${source.platform}`;
  }
  if (!source.featureEnabled) {
    return "Computer Use is not enabled in this session (the official computer-use plugin is disabled)";
  }
  if (!source.helperConnected && !source.helperLazyStartable) {
    return "the verified AceVra Computer Use Helper is not connected to this session (Computer Use runs only inside the AceVra desktop app with the Helper granted)";
  }
  if (!source.nodeReplToolName) {
    return "the js (node_repl) tool that hosts the Computer Use SDK is not registered in this session";
  }
  if (source.runtimeScope === "subagent") {
    return "Computer Use is not available in subagents; only the main conversation can control apps";
  }
  return undefined;
}

function projectAction(
  entry: ComputerUseSurfaceEntry,
  source: ComputerCapabilitySource,
  capabilityReason: string | undefined,
): CapabilityAction {
  const foreground = entry.kind === "foreground";
  const reason =
    capabilityReason ??
    (foreground && !source.foregroundAvailable ? PROTECTED_FOREGROUND_REASON : undefined);
  const mcpToolName = computerMcpToolName(entry.name);
  return {
    canonicalName: entry.name,
    invocation: {
      kind: "node_repl",
      toolName: source.nodeReplToolName ?? "js",
      expression: `await agent.computerUse["${entry.name}"](${entry.args})`,
      ...(source.registeredToolNames.has(mcpToolName) ? { mcpToolName } : {}),
    },
    ...(entry.note ? { description: entry.note } : {}),
    argsHint: entry.args,
    ...(entry.returns ? { outputSummary: entry.returns } : {}),
    availability: reason ? "unavailable" : "available",
    ...(reason ? { unavailableReason: reason } : {}),
    risk: { readOnly: entry.kind === "read", foreground, sideEffectScope: "system" },
  };
}

export function projectComputerCapability(source: ComputerCapabilitySource): Capability {
  const reason = capabilityUnavailableReason(source);
  return {
    id: COMPUTER_CAPABILITY_ID,
    domain: "computer",
    displayName: "Computer (this Mac, background)",
    source: "computer",
    // 修复依据：computer.screenshot 已是 facade 的合法别名，模型清单必须从同一别名表投影。
    actions: COMPUTER_USE_SURFACE.flatMap((entry) => [
      projectAction(entry, source, reason),
      ...Object.entries(COMPUTER_USE_COMPAT_ALIASES)
        .filter(([, target]) => target === entry.name)
        .map(([name]) => projectAction({ ...entry, name }, source, reason)),
    ]),
    availability: reason ? "unavailable" : "available",
    ...(reason ? { unavailableReason: reason } : {}),
    executionTargets: [THIS_DEVICE_TARGET],
    relatedSkills: [],
    providerVisible: source.nodeReplToolName !== undefined,
    keywords: ["computer", "computer use", "mac app"],
    limits: [...COMPUTER_USE_LIMITS],
  };
}
