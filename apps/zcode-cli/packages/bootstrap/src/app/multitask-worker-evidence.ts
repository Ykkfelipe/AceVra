// ============================================================
// Multitask worker 证据：driver 是 `evidence` 的唯一写入者
// ============================================================
// 原因：M1 实测中写 worker 在没有工具可用时只说一句开场白就结束 turn，run 依然显示 2/2 完成——
// 「turn 结束」被当成了「任务完成」。M2 让每个 Multitask 任务成为 typed ask，worker 必须显式
// 声明 status；而能证明它真的动过手的只能是运行时观察到的工具调用，不能是模型自述。
//
// 所以在 submit_result 载荷交给引擎之前，driver 用本 ask 观察到的计数**覆盖** `evidence`：
// 模型自己填的 evidence 一律丢弃。被接受的载荷就是 journal 里的节点结果，因此证据随节点落库、
// resume 时原样重放。普通 Workflow 的 persona 没有 worker 策略，永不加盖。
//
// 跨 resume 的累计（Cross-Mode 集成时 live 发现）：被 Stop 打断的任务在 resume 后重派进**同一个**
// worker 会话，会话里还留着上一次尝试读过的文件；worker 可能只调一次 submit_result。逐尝试计数在
// startAsk 归零，于是真干过活的 worker 被判成 unverified（dwfrun-80e9fcbe：打断前 12 次工具调用，
// resume 后 0 次）。修复依据：M2 的逐工具 node-progress 已经把尝试中的状态落进 journal，这里让它带上
// 证据快照，重派时按「同一 run、同一 ask 实例、更早的生命周期」把快照累加进来。

import type {
  AskEvidence,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
} from "@zcode/dynamic-workflow";
import type { ActorToolCounts } from "./workflow-driver-tool-activity.js";
import type { SessionState } from "./workflow-driver-types.js";

/** 累计证据里列出的改动文件上限（与单次尝试的上限一致）。 */
const MAX_CHANGED_FILES = 32;

/** 这个 actor 是否 Multitask worker（persona 上有冻结的 worker 策略）。 */
export function isMultitaskWorkerPersona(persona: PersonaSpec): boolean {
  return persona.worker !== undefined;
}

/**
 * 同一任务在**更早的生命周期**里被打断的尝试留下的证据（无则 undefined）。
 *
 * - 只读本 run 的 journal：Amend 铸新 run id，前驱 run 的工作不会被算进来；
 * - 只认同一个 ask 实例（siteId@ordinal）：同一 worker 的其他任务不会被算进来；
 * - 生命周期以 `run-started` 分界，当前生命周期（最后一个 run-started 之后）不算——那是本次尝试；
 * - 每个生命周期取该实例**最后**一条带证据的进度（快照是累计值），跨生命周期相加。
 *
 * 已完成的任务在 resume 时以 cached 结算、根本不会重派，所以永远走不到这里，保持 Reused。
 */
export function carriedMultitaskEvidence(
  journal: Pick<JournalStorePort, "listEvents">,
  runId: string,
  instance: InstanceRef,
): AskEvidence | undefined {
  const events = journal.listEvents(runId);
  let currentLife = -1;
  for (const [index, stored] of events.entries()) {
    if (stored.event.type === "run-started") currentLife = index;
  }
  const lives: AskEvidence[] = [];
  let latest: AskEvidence | undefined;
  for (const stored of events.slice(0, Math.max(0, currentLife))) {
    const event = stored.event;
    if (event.type === "run-started") {
      if (latest !== undefined) lives.push(latest);
      latest = undefined;
      continue;
    }
    if (
      event.type === "node-progress" &&
      event.instance.siteId === instance.siteId &&
      event.instance.ordinal === instance.ordinal &&
      event.evidence !== undefined
    )
      latest = event.evidence;
  }
  if (latest !== undefined) lives.push(latest);
  return lives.length === 0 ? undefined : lives.reduce(addEvidence);
}

/** 这个 typed ask 的结果 schema 是否声明了 `evidence.priorAttempts`（修复之前铸的 run 没有）。 */
export function schemaDeclaresPriorAttempts(schema: unknown): boolean {
  const evidence = readProperty(readProperty(schema, "properties"), "evidence");
  return readProperty(readProperty(evidence, "properties"), "priorAttempts") !== undefined;
}

/**
 * 把运行时观察到的计数盖到 worker 提交的结果上。非对象载荷原样返回：它反正过不了 schema，
 * 由引擎的 repair 通道照常拒绝，这里不替模型修形状。
 *
 * `carried` 是同一任务被打断的尝试留下的证据：总数里含它（结局规则看总数），并在 schema 允许时
 * 单独列成 `priorAttempts`，让 UI 能分清「resume 前做的」与「这次新做的」。
 */
export function stampMultitaskEvidence(
  payload: unknown,
  counts: ActorToolCounts,
  carried?: { evidence: AskEvidence; declared: boolean },
): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const total = carried === undefined ? counts : addEvidence(counts, carried.evidence);
  return {
    ...(payload as Record<string, unknown>),
    evidence: {
      toolCalls: total.toolCalls,
      worldToolCalls: total.worldToolCalls,
      mutatingToolCalls: total.mutatingToolCalls,
      commandCalls: total.commandCalls,
      filesChanged: [...total.filesChanged],
      ...(carried?.declared === true
        ? {
            priorAttempts: {
              toolCalls: carried.evidence.toolCalls,
              worldToolCalls: carried.evidence.worldToolCalls,
              mutatingToolCalls: carried.evidence.mutatingToolCalls,
              commandCalls: carried.evidence.commandCalls,
            },
          }
        : {}),
    },
  };
}

/** submit 桥接交给引擎的载荷：Multitask worker 盖上本任务的证据（含被打断尝试的累计），其余原样。 */
export function multitaskSubmission(
  state: Pick<SessionState, "multitaskWorker" | "modelActivity" | "carriedEvidence">,
  payload: unknown,
): unknown {
  return state.multitaskWorker
    ? stampMultitaskEvidence(payload, state.modelActivity.toolCounts(), state.carriedEvidence)
    : payload;
}

/**
 * startAsk 时为 Multitask worker 求本任务的累计证据；不是 worker、不是 typed、或没有被打断的
 * 更早尝试时为 undefined（今天的行为原样不变）。
 */
export function carriedEvidenceForAsk(
  input: { journal: Pick<JournalStorePort, "listEvents">; runId?: string },
  state: Pick<SessionState, "multitaskWorker">,
  instance: InstanceRef,
  message: { typed: boolean; schema?: unknown },
): SessionState["carriedEvidence"] {
  if (!state.multitaskWorker || !message.typed) return undefined;
  const evidence = carriedMultitaskEvidence(input.journal, input.runId ?? "run", instance);
  return evidence === undefined
    ? undefined
    : { evidence, declared: schemaDeclaresPriorAttempts(message.schema) };
}

function addEvidence(left: AskEvidence, right: AskEvidence): AskEvidence {
  return {
    toolCalls: left.toolCalls + right.toolCalls,
    worldToolCalls: left.worldToolCalls + right.worldToolCalls,
    mutatingToolCalls: left.mutatingToolCalls + right.mutatingToolCalls,
    commandCalls: left.commandCalls + right.commandCalls,
    filesChanged: [...new Set([...left.filesChanged, ...right.filesChanged])].slice(
      0,
      MAX_CHANGED_FILES,
    ),
  };
}

function readProperty(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
