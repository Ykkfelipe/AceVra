import type {
  WorkflowRunActor,
  WorkflowRunNode,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Multitask worker-first 视图的纯模型：run 读模型 → 每个 worker 一行。
 *
 * 两个事实来源，各有唯一所有者，这里只读不判：
 * - **结局**来自降级脚本逐任务 `report()` 的条目（core/multitask-graph.ts 是判定的唯一所有者，
 *   按 worker 声明 + driver 盖章的运行时证据推出）。UI 不重算规则，只把它画出来。
 * - **进行中**的状态来自节点相位与 `node-progress`（当前工具、轮次、工具调用数）。
 *
 * 任务还没报出结局时，按节点相位与 run 终态给出等待 / 工作中 / 已停止 / 失败。
 */

export type MultitaskOutcome =
  | "done"
  | "done_no_changes"
  | "unverified"
  | "blocked"
  | "failed"
  | "skipped";

export type MultitaskWorkerState =
  | "waiting"
  | "working"
  | "submitting"
  | "stopped"
  | "failed"
  | MultitaskOutcome;

export interface MultitaskEvidence {
  toolCalls: number;
  worldToolCalls: number;
  mutatingToolCalls: number;
  commandCalls: number;
  filesChanged: string[];
  /** 报告条目里截短前的改动文件总数。 */
  filesChangedTotal?: number;
}

export interface MultitaskTaskView {
  task: string;
  outcome: MultitaskOutcome;
  result: string;
  evidence?: MultitaskEvidence;
}

export interface MultitaskWorkerView {
  key: string;
  siteId: string;
  ordinal: number;
  sessionId?: string;
  /** 完整 actor 名（`id: role`），打开 transcript 时交给宿主。 */
  actorName?: string;
  workerId: string;
  role: string;
  access: "read" | "write";
  avatarIndex: number;
  state: MultitaskWorkerState;
  /** 正在做的事（工具名 + 目标线索）；只在 working 时在场。 */
  action?: { name: string; target?: string };
  /** 本 worker 已观察到的工具调用数（进行中按节点读数、结算后按证据汇总）。 */
  toolCalls: number;
  /** 汇总证据：只来自已报出的任务结局。 */
  evidence?: MultitaskEvidence;
  tasks: MultitaskTaskView[];
  /** 至少一个任务是 resume 时从 journal 复用的（缓存命中，本次没有重跑）。 */
  reused: boolean;
}

/** 这条 run 是否 Multitask：actor 带冻结的 worker 读写权限。 */
export function isMultitaskRun(run: WorkflowRunState | undefined): boolean {
  return run?.actors.some((actor) => actor.access !== undefined) === true;
}

/** 结局的严重度：一行汇总多个任务时取最差的那个说。 */
const OUTCOME_RANK: Record<MultitaskOutcome, number> = {
  failed: 0,
  blocked: 1,
  skipped: 2,
  unverified: 3,
  done_no_changes: 4,
  done: 5,
};

export function buildMultitaskBoard(run: WorkflowRunState): MultitaskWorkerView[] {
  const reports = readTaskReports(run);
  const terminal = run.status !== "running" && run.status !== "pending";
  return run.actors
    .filter((actor) => actor.access !== undefined)
    .map((actor, index) => buildWorker(run, actor, index, reports, terminal));
}

function buildWorker(
  run: WorkflowRunState,
  actor: WorkflowRunActor,
  index: number,
  reports: ReadonlyMap<string, MultitaskTaskView[]>,
  terminal: boolean,
): MultitaskWorkerView {
  const { workerId, role } = splitActorName(actor.name, actor.siteId);
  const nodes = run.nodes.filter(
    (node) =>
      node.kind !== "world-read" &&
      node.actorSiteId === actor.siteId &&
      node.actorOrdinal === actor.ordinal,
  );
  const tasks = reports.get(workerId) ?? [];
  const evidence = sumEvidence(tasks);
  const active = nodes.find((node) => isExecuting(node));
  const live = nodes.find((node) => node.phase !== "settled");
  const state = deriveState({ active, live, nodes, tasks, terminal });
  const liveToolCalls = nodes.reduce((sum, node) => sum + (node.toolCalls ?? 0), 0);
  return {
    key: `${actor.siteId}@${actor.ordinal}`,
    siteId: actor.siteId,
    ordinal: actor.ordinal,
    ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
    ...(actor.name === undefined ? {} : { actorName: actor.name }),
    workerId,
    role,
    access: actor.access ?? "read",
    avatarIndex: index,
    state,
    ...(state === "working" && active?.lastTool !== undefined ? { action: active.lastTool } : {}),
    toolCalls: Math.max(liveToolCalls, evidence?.toolCalls ?? 0),
    ...(evidence === undefined ? {} : { evidence }),
    tasks,
    reused: nodes.some((node) => node.cached === true),
  };
}

function deriveState(input: {
  active: WorkflowRunNode | undefined;
  live: WorkflowRunNode | undefined;
  nodes: readonly WorkflowRunNode[];
  tasks: readonly MultitaskTaskView[];
  terminal: boolean;
}): MultitaskWorkerState {
  const { active, live, nodes, tasks, terminal } = input;
  if (!terminal && active !== undefined) return active.phase === "nudged" ? "submitting" : "working";
  if (!terminal && live !== undefined) return "waiting";
  const worst = worstOutcome(tasks);
  // 终态 run 里还有没报出结局的任务（被停下、或从未开始）：已报出的结局不能冒充整行的结论。
  const unreported = nodes.some(
    (node) => node.phase !== "settled" || node.outcome === "cancelled",
  );
  if (terminal && unreported) return "stopped";
  if (worst !== undefined) return worst;
  if (nodes.some((node) => node.outcome === "failed")) return "failed";
  return terminal ? "stopped" : "waiting";
}

function isExecuting(node: WorkflowRunNode): boolean {
  return node.phase === "executing" || node.phase === "repairing" || node.phase === "nudged";
}

function worstOutcome(tasks: readonly MultitaskTaskView[]): MultitaskOutcome | undefined {
  let worst: MultitaskOutcome | undefined;
  for (const task of tasks) {
    if (worst === undefined || OUTCOME_RANK[task.outcome] < OUTCOME_RANK[worst]) worst = task.outcome;
  }
  return worst;
}

function sumEvidence(tasks: readonly MultitaskTaskView[]): MultitaskEvidence | undefined {
  const withEvidence = tasks.filter((task) => task.evidence !== undefined);
  if (withEvidence.length === 0) return undefined;
  const files = new Set<string>();
  let largestTaskTotal = 0;
  const total: MultitaskEvidence = {
    toolCalls: 0,
    worldToolCalls: 0,
    mutatingToolCalls: 0,
    commandCalls: 0,
    filesChanged: [],
  };
  for (const { evidence } of withEvidence) {
    total.toolCalls += evidence!.toolCalls;
    total.worldToolCalls += evidence!.worldToolCalls;
    total.mutatingToolCalls += evidence!.mutatingToolCalls;
    total.commandCalls += evidence!.commandCalls;
    for (const file of evidence!.filesChanged) files.add(file);
    largestTaskTotal = Math.max(largestTaskTotal, evidence!.filesChangedTotal ?? 0);
  }
  total.filesChanged = [...files];
  // 跨任务的同一文件只算一次（按路径去重）；报告条目截短过路径清单时，单个任务的总数是可靠下界。
  total.filesChangedTotal = Math.max(files.size, largestTaskTotal);
  return total;
}

/** actor 名是降级脚本铸的 `${workerId}: ${role}`；读不出时退回站点 id。 */
function splitActorName(name: string | undefined, fallback: string): { workerId: string; role: string } {
  if (name === undefined) return { workerId: fallback, role: fallback };
  const separator = name.indexOf(": ");
  if (separator <= 0) return { workerId: name, role: name };
  return { workerId: name.slice(0, separator), role: name.slice(separator + 2) };
}

const OUTCOMES = new Set<string>(["done", "done_no_changes", "unverified", "blocked", "failed", "skipped"]);

/** 报告条目（`report()` 的 JSON 预览）→ 按 worker id 分组的任务结局。读不出的条目跳过。 */
function readTaskReports(run: WorkflowRunState): Map<string, MultitaskTaskView[]> {
  const byWorker = new Map<string, MultitaskTaskView[]>();
  for (const report of run.reports ?? []) {
    const item = parseJson(report.preview);
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.multitaskTask !== "string" ||
      typeof record.worker !== "string" ||
      typeof record.outcome !== "string" ||
      !OUTCOMES.has(record.outcome)
    )
      continue;
    const evidence = readEvidence(record.evidence);
    const task: MultitaskTaskView = {
      task: record.multitaskTask,
      outcome: record.outcome as MultitaskOutcome,
      result: typeof record.result === "string" ? record.result : "",
      ...(evidence === undefined ? {} : { evidence }),
    };
    // 同一任务只保留最后一条（resume 不会重报，但防御一下重复）。
    const list = byWorker.get(record.worker) ?? [];
    const existing = list.findIndex((entry) => entry.task === task.task);
    if (existing >= 0) list[existing] = task;
    else list.push(task);
    byWorker.set(record.worker, list);
  }
  return byWorker;
}

function readEvidence(value: unknown): MultitaskEvidence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const count = (key: string) =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : 0;
  const files = Array.isArray(record.filesChanged)
    ? record.filesChanged.filter((file): file is string => typeof file === "string")
    : [];
  return {
    toolCalls: count("toolCalls"),
    worldToolCalls: count("worldToolCalls"),
    mutatingToolCalls: count("mutatingToolCalls"),
    commandCalls: count("commandCalls"),
    filesChanged: files,
    filesChangedTotal: Math.max(files.length, count("filesChangedTotal")),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
