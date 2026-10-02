// 能力层的每轮度量（core/specs/capability-runtime.md "Observability"）：
// 无效工具调用数、能力发现调用数、提交 → 首个有效动作的耗时、provider 工具表投影耗时。
// 纯计数，不影响执行；每轮至多一条 info 日志。
import { CoreErrorType } from "@zcode/contracts";
import type { ToolCall, TraceContext } from "@zcode/contracts";
import { CAPABILITIES_TOOL } from "../../capability/index.js";
import type { ToolExecutionResult } from "../../tool/types.js";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const INVALID_TOOL_ERROR_TYPES: ReadonlySet<string> = new Set([
  CoreErrorType.ToolNotFound,
  CoreErrorType.InvalidInput,
]);
// 修复依据（installed 64a7a1a9 实测 A2）：旧判定只认 describe()，把 import client.mjs、
// Object.keys(agent.computerUse) 与对插件缓存的 find/ls 记成"有效动作"，首个有效动作时间被低估。
const COMPUTER_DISCOVERY_CODE_PATTERN =
  /computerUse\s*(?:\.\s*describe|\[\s*["']describe["']\s*\])\s*\(|Object\.(?:keys|getOwnPropertyNames)\(\s*agent\b|client\.mjs|computer-use-client/u;
// 读/搜 Computer 运行时或插件文件来找调用方式，同属能力发现。
const COMPUTER_SOURCE_PROBE_PATTERN =
  /plugins\/cache\/[^"'\s]*computer-use|zcode-cua|computer-surface|computer-use-client|skills\/computer-use/u;
const SOURCE_PROBE_TOOLS: ReadonlySet<string> = new Set(["Bash", "Read", "Grep", "Glob"]);
const NODE_REPL_TOOL_PATTERN = /^(?:js|mcp__.*node_repl.*__js)$/u;
// Computer 拒绝（未知方法 / 参数形状错误）与 facade 上不存在的属性同样是"猜错 API"，按无效调用计。
// js 单元的异常不会让工具失败，而是落在 output.error，所以两处都要看。
const COMPUTER_GUESS_PATTERN =
  /is not available: supported tools|expects .* See `await agent\.computerUse\.describe\(\)`|computerUse(?:\.[\w$]+|\[[^\]]+\])(?:\(\.\.\.\))? is not a function|agent is not defined/u;

export interface CapabilityTurnMetrics {
  turnStartedAt: number;
  toolCalls: number;
  invalidToolCalls: number;
  discoveryCalls: number;
  firstValidToolActionMs?: number;
  toolSchemaBuildMs?: number;
}

const metricsByRuntime = new WeakMap<AgentRuntimeInternal, CapabilityTurnMetrics>();

export function startCapabilityTurnMetrics(
  runtime: AgentRuntimeInternal,
  turnStartedAt: number,
): void {
  metricsByRuntime.set(runtime, {
    turnStartedAt,
    toolCalls: 0,
    invalidToolCalls: 0,
    discoveryCalls: 0,
  });
}

export function recordCapabilityToolSchemaBuild(
  runtime: AgentRuntimeInternal,
  durationMs: number,
): void {
  const metrics = metricsByRuntime.get(runtime);
  if (metrics && metrics.toolSchemaBuildMs === undefined) metrics.toolSchemaBuildMs = durationMs;
}

function isDiscoveryCall(result: ToolExecutionResult, toolCall: ToolCall | undefined): boolean {
  if (result.toolName === CAPABILITIES_TOOL) return true;
  if (SOURCE_PROBE_TOOLS.has(result.toolName)) {
    return COMPUTER_SOURCE_PROBE_PATTERN.test(JSON.stringify(toolCall?.input ?? {}));
  }
  if (!NODE_REPL_TOOL_PATTERN.test(result.toolName)) return false;
  const code = (toolCall?.input as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && COMPUTER_DISCOVERY_CODE_PATTERN.test(code);
}

function cellErrorText(result: ToolExecutionResult): string {
  if (!NODE_REPL_TOOL_PATTERN.test(result.toolName)) return "";
  const error = (result.output as { error?: unknown } | undefined)?.error;
  if (error === undefined) return "";
  return typeof error === "string" ? error : JSON.stringify(error);
}

function isInvalidCall(result: ToolExecutionResult): boolean {
  if (!result.success && INVALID_TOOL_ERROR_TYPES.has(result.error?.type ?? "")) return true;
  const text = result.success ? cellErrorText(result) : (result.error?.message ?? "");
  return COMPUTER_GUESS_PATTERN.test(text);
}

export function recordCapabilityToolResults(
  runtime: AgentRuntimeInternal,
  results: readonly ToolExecutionResult[],
  toolCalls: readonly ToolCall[],
): void {
  const metrics = metricsByRuntime.get(runtime);
  if (!metrics) return;
  const callsById = new Map(toolCalls.map((call) => [call.id, call]));
  for (const result of results) {
    metrics.toolCalls += 1;
    const discovery = isDiscoveryCall(result, callsById.get(result.toolCallId));
    if (discovery) metrics.discoveryCalls += 1;
    if (isInvalidCall(result)) {
      metrics.invalidToolCalls += 1;
      continue;
    }
    const valid = result.success && cellErrorText(result) === "";
    if (valid && !discovery && metrics.firstValidToolActionMs === undefined) {
      metrics.firstValidToolActionMs = result.completedAt.getTime() - metrics.turnStartedAt;
    }
  }
}

export function flushCapabilityTurnMetrics(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): CapabilityTurnMetrics | undefined {
  const metrics = metricsByRuntime.get(runtime);
  metricsByRuntime.delete(runtime);
  if (!metrics || metrics.toolCalls === 0) return metrics;
  runtime.logger?.info("Capability turn metrics", {
    ...traceContextToLogContext(traceContext),
    discoveryCalls: metrics.discoveryCalls,
    event: "capability.turn.metrics",
    firstValidToolActionMs: metrics.firstValidToolActionMs,
    invalidToolCalls: metrics.invalidToolCalls,
    module: "core.runtime",
    toolCalls: metrics.toolCalls,
    toolSchemaBuildMs: metrics.toolSchemaBuildMs,
  });
  return metrics;
}
