// capability_context 的 runtime 侧：收集权威 sources → 纯快照 → 确定性选择 → 本轮提醒。
// 规范：core/specs/capability-runtime.md。
// 失败语义与 plugin_reference 一致：对话 fail open（异常不阻塞本轮），能力声明 fail closed
// （异常时不注入任何内容）。本文件只读权威注册表，不持有第二份能力状态；唯一缓存是
// execution target 列表（有界 + TTL）与上次 MCP 状态，二者都只是读缓存。
import type { CapabilitySnapshot, TraceContext } from "@zcode/contracts";
import {
  buildCapabilitySnapshot,
  renderCapabilityContext,
  selectRelevantCapabilities,
  type CapabilityRuntimeCache,
  type CapabilitySources,
} from "../../capability/index.js";
import { getCapturedZCodeCuaBrokerCredentials } from "@zcode/shared";
import { toMcpToolName } from "../../mcp/index.js";
import { extractPluginReferences } from "../../plugin-reference/index.js";
import { CORE_COMPUTER_FOREGROUND_CONTROL_ALLOWED } from "../../tool/handlers/node-repl-cua.js";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const TARGET_LIST_TIMEOUT_MS = 300;
const TARGET_LIST_TTL_MS = 60_000;
const CAPABILITY_CONTEXT_SOURCE = "capability_context";

function cacheOf(runtime: AgentRuntimeInternal): CapabilityRuntimeCache {
  runtime.capabilityCache ??= {};
  return runtime.capabilityCache;
}

function targetsFresh(cache: CapabilityRuntimeCache): boolean {
  return cache.targets !== undefined && Date.now() - cache.targets.at < TARGET_LIST_TTL_MS;
}

/** 有界刷新目标列表：超时/失败返回 false，绝不编造；成功写入 TTL 缓存。 */
function refreshTargets(runtime: AgentRuntimeInternal): Promise<boolean> {
  const port = runtime.executionTargetPort;
  const cache = cacheOf(runtime);
  if (!port) return Promise.resolve(false);
  if (targetsFresh(cache)) return Promise.resolve(true);
  cache.targetsRefresh ??= port
    .listTargets()
    .then((listed) => {
      if (listed.ok) cache.targets = { value: listed.targets, at: Date.now() };
      return listed.ok;
    })
    .catch(() => false)
    .finally(() => {
      cache.targetsRefresh = undefined;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), TARGET_LIST_TIMEOUT_MS);
  });
  return Promise.race([cache.targetsRefresh, timeout]).finally(() => clearTimeout(timer));
}

async function refreshMcp(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.mcpPort) return;
  // initializeMcp 幂等；turn loop 的首个 provider 请求前本来就会等它，这里不增加净等待。
  await runtime.initializeMcp(traceContext);
  const statuses = await runtime.mcpPort.status();
  const snapshot = runtime.mcpStartupPromise ? await runtime.mcpStartupPromise : undefined;
  const cache = cacheOf(runtime);
  cache.mcpServers = Object.entries(statuses).map(([serverName, status]) => ({
    serverName,
    status: status.status,
    ...(status.error ? { error: status.error } : {}),
  }));
  cache.mcpTools = (snapshot?.tools ?? []).map((descriptor) => ({
    serverName: descriptor.serverName,
    toolName: descriptor.toolName,
    registeredName: toMcpToolName(descriptor),
  }));
}

function runtimeSources(
  runtime: AgentRuntimeInternal,
  toolDisallowlist: readonly string[] | undefined,
  discoveryMs?: number,
): CapabilitySources {
  const cache = cacheOf(runtime);
  // 与 turn-loop 的 provider 工具过滤保持同一"完整工具名"语义。
  const disallowed = new Set(toolDisallowlist ?? []);
  const port = runtime.executionTargetPort;
  const selected = port?.selectedTarget();
  const runtimeFeatures = runtime.config.runtimeFeatures;
  return {
    tools: runtime.getTools().filter((tool) => !disallowed.has(tool.name)),
    mcpServers: cache.mcpServers ?? [],
    mcpTools: cache.mcpTools ?? [],
    pluginCatalog: runtime.config.pluginReferenceCatalog,
    skills: runtime.skillLoadOutcome?.skills ?? [],
    computer: {
      featureEnabled: runtimeFeatures?.computerUse === true,
      helperConnected: Boolean(getCapturedZCodeCuaBrokerCredentials().socket?.trim()),
      platform: process.platform,
      runtimeScope: runtime.config.taskType === "subagent_child" ? "subagent" : "main",
      foregroundAvailable: CORE_COMPUTER_FOREGROUND_CONTROL_ALLOWED,
    },
    browser: {
      enabled: runtimeFeatures?.browserUse === true && runtime.browserControlPort !== undefined,
    },
    executionTargets: {
      portPresent: port !== undefined,
      ...(selected ? { selected } : {}),
      ...(cache.targets ? { targets: cache.targets.value } : {}),
      listResolved: targetsFresh(cache),
    },
    ...(discoveryMs === undefined ? {} : { discoveryMs }),
  };
}

/** 同步快照：注册表实时 + 异步部分取最近一次缓存。供结构化错误使用。 */
export function buildRuntimeCapabilitySnapshot(
  runtime: AgentRuntimeInternal,
  toolDisallowlist?: readonly string[],
): CapabilitySnapshot {
  return buildCapabilitySnapshot(runtimeSources(runtime, toolDisallowlist));
}

/** 完整快照：先刷新 MCP 状态与（有界）目标列表。供 Capabilities 工具使用。 */
export async function collectRuntimeCapabilitySnapshot(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  toolDisallowlist?: readonly string[],
): Promise<CapabilitySnapshot> {
  const startedAt = Date.now();
  await Promise.all([refreshMcp(runtime, traceContext), refreshTargets(runtime)]);
  return buildCapabilitySnapshot(runtimeSources(runtime, toolDisallowlist, Date.now() - startedAt));
}

function alreadyInHistory(runtime: AgentRuntimeInternal, body: string): boolean {
  // 热会话里同一份能力上下文已在历史中：不重复追加（避免每轮堆积 4–8 KiB）。
  return runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .some((entry) => "kind" in entry && entry.kind === "attachment" && entry.content === body);
}

export async function injectCapabilityContextFromTurn(
  runtime: AgentRuntimeInternal,
  input: { userInput: string; traceContext: TraceContext; toolDisallowlist?: readonly string[] },
): Promise<void> {
  const startedAt = Date.now();
  try {
    const references = extractPluginReferences(input.userInput).references;
    // 目标列表过期时后台刷新（不阻塞本轮）；本轮先用缓存/词表。远程意图命中时才有界等待。
    const pre = selectRelevantCapabilities(
      buildRuntimeCapabilitySnapshot(runtime, input.toolDisallowlist),
      {
        text: input.userInput,
        pluginReferences: references,
      },
    );
    const remoteIntent = pre.selected.some(
      (entry) =>
        entry.capabilityId === "remote_computer" || entry.capabilityId === "execution_targets",
    );
    const targetRefresh = refreshTargets(runtime);
    if (remoteIntent) await targetRefresh;
    if (pre.selected.length === 0 && references.length === 0) {
      // 绝对主路径：无相关能力，零注入。MCP 名只能在已缓存/已注册时命中，断开 server
      // 的状态在下面的完整收集里刷新，供后续轮次与 Capabilities 工具使用。
      void refreshMcp(runtime, input.traceContext).catch(() => undefined);
      return;
    }
    await refreshMcp(runtime, input.traceContext);
    const discoveryMs = Date.now() - startedAt;
    const snapshot = buildCapabilitySnapshot(
      runtimeSources(runtime, input.toolDisallowlist, discoveryMs),
    );
    const selectionStartedAt = Date.now();
    const selection = selectRelevantCapabilities(snapshot, {
      text: input.userInput,
      pluginReferences: references,
    });
    const body = renderCapabilityContext(snapshot, selection);
    runtime.logger?.debug("Capability snapshot built", {
      ...traceContextToLogContext(input.traceContext),
      capabilityCount: snapshot.diagnostics.capabilityCount,
      discoveryMs,
      event: "capability.snapshot.built",
      injected: body !== null,
      module: "core.runtime",
      omittedCount: selection.omittedCount,
      selected: selection.selected,
      selectionMs: Date.now() - selectionStartedAt,
      targetListResolved: snapshot.diagnostics.targetListResolved,
    });
    if (!body || alreadyInHistory(runtime, body)) return;
    runtime.messageHistory.addAttachment(CAPABILITY_CONTEXT_SOURCE, body);
  } catch (error) {
    runtime.logger?.debug("Capability context generation failed", {
      ...traceContextToLogContext(input.traceContext),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      event: "capability.context.failed",
      module: "core.runtime",
    });
  }
}
