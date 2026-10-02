// 执行目标 / 远程电脑 / 浏览器能力投影。
// 规则：远程目标绝不冒充本机能力——Computer（本机）与 RemoteComputer（SSH 电脑）是两个能力，
// executionTargets 分别是 this-device 与具体 target id。
import type {
  Capability,
  ExecutionTargetInfo,
  ModelToolContract,
  SelectedExecutionTarget,
} from "@zcode/contracts";
import { toolContractAction } from "./actions.js";
import { EXECUTION_TARGET_TOOLS, REMOTE_COMPUTER_TOOL, THIS_DEVICE_TARGET } from "./domains.js";

export interface CapabilityExecutionTargetSource {
  portPresent: boolean;
  selected?: SelectedExecutionTarget;
  targets?: readonly ExecutionTargetInfo[];
  /** listTargets 在预算内成功返回；false 时绝不编造目标列表。 */
  listResolved: boolean;
}

export const NO_TARGETS_REASON =
  "this session has no access to the user's other computers (only Desktop main conversations in a local workspace can use AceVra Nodes and SSH computers)";
const REMOTE_COMPUTER_CAPABILITY = "computerUse";

function describeTarget(target: ExecutionTargetInfo): string {
  const state = target.online ? (target.available ? "online" : "unavailable") : "offline";
  const reason = target.unavailableReason ? ` (${target.unavailableReason})` : "";
  const caps =
    target.capabilities.length > 0 ? `; capabilities: ${target.capabilities.join(", ")}` : "";
  return `${target.displayName} — targetId "${target.id}", ${target.type}, ${state}${reason}${caps}`;
}

function remoteTargets(source: CapabilityExecutionTargetSource): ExecutionTargetInfo[] {
  return (source.targets ?? []).filter((target) => !target.isThisDevice);
}

function targetKeywords(targets: readonly ExecutionTargetInfo[]): string[] {
  return targets.map((target) => target.displayName.trim().toLowerCase()).filter(Boolean);
}

function projectExecutionTargets(
  tools: readonly ModelToolContract[],
  source: CapabilityExecutionTargetSource,
): Capability {
  const contracts = tools.filter((tool) =>
    (EXECUTION_TARGET_TOOLS as readonly string[]).includes(tool.name),
  );
  const targets = remoteTargets(source);
  const reason = !source.portPresent || contracts.length === 0 ? NO_TARGETS_REASON : undefined;
  const limits = reason
    ? []
    : source.listResolved
      ? targets.length > 0
        ? targets.map((target) => `Known computer: ${describeTarget(target)}`)
        : ["No other computers are connected; RunOnTarget has no valid targetId right now."]
      : ["The computer list was not resolved yet; call ExecutionTargets before RunOnTarget."];
  return {
    id: "execution_targets",
    domain: "execution_targets",
    displayName: "Other computers: run processes (AceVra Nodes, SSH)",
    source: "execution_target",
    actions: reason ? [] : contracts.map(toolContractAction),
    availability: reason ? "unavailable" : "available",
    ...(reason ? { unavailableReason: reason } : {}),
    executionTargets: targets.filter((target) => target.online).map((target) => target.id),
    relatedSkills: [],
    providerVisible: !reason,
    keywords: targetKeywords(targets),
    limits,
  };
}

function remoteComputerReason(
  registered: boolean,
  source: CapabilityExecutionTargetSource,
  sshTargets: readonly ExecutionTargetInfo[],
): string | undefined {
  if (!source.portPresent || !registered) return NO_TARGETS_REASON;
  if (!source.listResolved) return undefined;
  if (sshTargets.length === 0) {
    return "no SSH computer with screen control (computerUse) is connected to AceVra";
  }
  if (!sshTargets.some((target) => target.online && target.available)) {
    return `no SSH computer is reachable right now: ${sshTargets.map(describeTarget).join("; ")}`;
  }
  return undefined;
}

function projectRemoteComputer(
  tools: readonly ModelToolContract[],
  source: CapabilityExecutionTargetSource,
): Capability {
  const contract = tools.find((tool) => tool.name === REMOTE_COMPUTER_TOOL);
  const sshTargets = remoteTargets(source).filter(
    (target) => target.type === "ssh" && target.capabilities.includes(REMOTE_COMPUTER_CAPABILITY),
  );
  const reason = remoteComputerReason(contract !== undefined, source, sshTargets);
  return {
    id: "remote_computer",
    domain: "remote_computer",
    displayName: "Remote computer screen control (SSH computers, not this Mac)",
    source: "execution_target",
    actions: reason || !contract ? [] : [toolContractAction(contract)],
    availability: reason ? "unavailable" : "available",
    ...(reason ? { unavailableReason: reason } : {}),
    executionTargets: sshTargets.map((target) => target.id),
    relatedSkills: [],
    providerVisible: !reason,
    keywords: targetKeywords(sshTargets),
    limits: reason
      ? []
      : [
          "Acts on the remote computer's screen only; the local Computer (agent.computerUse) always acts on this Mac.",
          ...sshTargets.map((target) => `Known SSH computer: ${describeTarget(target)}`),
        ],
  };
}

export function projectTargetCapabilities(
  tools: readonly ModelToolContract[],
  source: CapabilityExecutionTargetSource,
): Capability[] {
  return [projectExecutionTargets(tools, source), projectRemoteComputer(tools, source)];
}

export function projectBrowserCapability(
  enabled: boolean,
  nodeReplToolName: string | undefined,
): Capability {
  const reason = !enabled
    ? "Browser Use is not enabled in this session (the official browser-use plugin is disabled or this host has no browser control)"
    : !nodeReplToolName
      ? "the js (node_repl) tool that hosts the browser SDK is not registered in this session"
      : undefined;
  return {
    id: "browser.local",
    domain: "browser",
    displayName: "Browser (in-app / managed browser on this Mac)",
    source: "native",
    actions: [
      {
        canonicalName: "agent.browsers",
        invocation: {
          kind: "node_repl",
          toolName: nodeReplToolName ?? "js",
          expression: "agent.browsers (API reference: the control-browser skill)",
        },
        description: "Open, navigate, inspect, click, type and screenshot web pages",
        availability: reason ? "unavailable" : "available",
        ...(reason ? { unavailableReason: reason } : {}),
        risk: { readOnly: false, sideEffectScope: "network" },
      },
    ],
    availability: reason ? "unavailable" : "available",
    ...(reason ? { unavailableReason: reason } : {}),
    executionTargets: [THIS_DEVICE_TARGET],
    relatedSkills: [],
    providerVisible: !reason,
    keywords: ["browser"],
  };
}
