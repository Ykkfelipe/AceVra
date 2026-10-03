import type { MultitaskInput } from "@zcode/contracts";
import { normalizeAgentProfiles, type AgentProfile } from "../../subagent/profile.js";

// 共享工作区中只读并发必须由工具边界保证，Bash/REPL/MCP 不能靠提示词证明只读。
export const MULTITASK_READ_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

/**
 * M2 结果契约与结局判定（写进每个降级脚本的前导）。
 *
 * 原因：M1 的 untyped ask 让「worker 结束 turn」直接等于「任务完成」——live 验收里一个没有工具的
 * writer 只说一句话就结束，run 仍显示 2/2。现在每个任务是 typed ask：worker 必须用 submit_result
 * 显式声明 done / blocked；不提交会被既有机制 nudge 一次，仍不提交即 ResultNotSubmitted。
 * `evidence` 由 driver 按运行时观察覆盖写入（bootstrap/multitask-worker-evidence.ts），结局由下面
 * 的纯函数按「声明 + 证据 + 读写权限」确定性推出——同一份脚本、同一份 journal，resume 重放得到
 * 同一个结局。Cancelled / ProviderStop / Interrupted 必须继续上抛，run 才会停成可恢复的 stopped。
 */
const MULTITASK_PRELUDE = String.raw`/** Objective runtime counts for this task. Filled in by the runtime from observed tool calls. */
interface MultitaskEvidence {
  toolCalls: number;
  worldToolCalls: number;
  mutatingToolCalls: number;
  commandCalls: number;
  filesChanged: string[];
  /** Part of the totals done in earlier attempts of this same task that were interrupted by a stop (filled in by the runtime). */
  priorAttempts?: { toolCalls: number; worldToolCalls: number; mutatingToolCalls: number; commandCalls: number };
}
/** Your result for this task. */
interface MultitaskTaskResult {
  /** "done" only if the assignment is actually complete; "blocked" if you could not complete it. */
  status: "done" | "blocked";
  /** The deliverable: findings or answer, or what you changed and how you checked it. When blocked: what stopped you. */
  result: string;
  /** Filled in by the runtime from your observed tool calls. Never provide it. */
  evidence?: MultitaskEvidence;
}
interface MultitaskOutcome {
  task: string;
  worker: string;
  outcome: "done" | "done_no_changes" | "unverified" | "blocked" | "failed" | "skipped";
  result: string;
  evidence?: MultitaskEvidence;
}
const MULTITASK_STOP_CODES = ["Cancelled", "ProviderStop", "Interrupted"];
function multitaskJudge(task: string, worker: string, access: string, value: MultitaskTaskResult): MultitaskOutcome {
  const evidence = value.evidence;
  const base = { task, worker, result: value.result, ...(evidence ? { evidence } : {}) };
  if (value.status === "blocked") return { ...base, outcome: "blocked" };
  if (!evidence || evidence.worldToolCalls === 0) return { ...base, outcome: "unverified" };
  if (access === "write" && evidence.mutatingToolCalls === 0) return { ...base, outcome: "done_no_changes" };
  return { ...base, outcome: "done" };
}
function multitaskFailed(task: string, worker: string, error: unknown): MultitaskOutcome {
  const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
  if (MULTITASK_STOP_CODES.includes(code)) throw error;
  const message = error instanceof Error ? error.message : String(error);
  return { task, worker, outcome: "failed", result: (code ? code + ": " : "") + message };
}
function multitaskBlockedBy(dependencies: MultitaskOutcome[]): MultitaskOutcome | undefined {
  return dependencies.find((entry) => entry.outcome === "blocked" || entry.outcome === "failed" || entry.outcome === "skipped");
}
function multitaskReport(outcome: MultitaskOutcome): MultitaskOutcome {
  const evidence = outcome.evidence;
  report({
    multitaskTask: outcome.task,
    worker: outcome.worker,
    outcome: outcome.outcome,
    result: outcome.result.slice(0, 400),
    ...(evidence ? { evidence: { ...evidence, filesChanged: evidence.filesChanged.slice(0, 6), filesChangedTotal: evidence.filesChanged.length } } : {}),
  });
  return outcome;
}`;

/** worker persona 里的结果契约：只说规则，不说提交机制（typed ask 的尾注负责那部分）。 */
const MULTITASK_WORKER_CONTRACT =
  "Do the assignment yourself with your tools, then submit your result. Declare status \"done\" only when the assignment is actually complete; declare \"blocked\" with the reason when you could not complete it. Ending your turn without submitting does not count as done. The runtime records which tools you actually used; a claim without matching tool use is reported as unverified.";

/** Validates a bounded DAG and lowers it to the existing Workflow facade. No execution state. */
export function buildMultitaskScript(
  input: MultitaskInput,
  profiles: readonly AgentProfile[],
  workerProfiles?: ReadonlyMap<string, AgentProfile>,
): string {
  const workers = new Map(input.workers.map((worker) => [worker.id, worker]));
  if (workers.size !== input.workers.length) throw new Error("Duplicate worker ID");
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  if (tasks.size !== input.tasks.length) throw new Error("Duplicate task ID");
  for (const task of input.tasks) {
    if (!workers.has(task.worker)) throw new Error(`Unknown worker: ${task.worker}`);
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
    }
  }
  for (const worker of input.workers) {
    if (!input.tasks.some((task) => task.worker === worker.id))
      throw new Error(`Unassigned worker: ${worker.id}`);
  }
  const ordered: MultitaskInput["tasks"] = [];
  const visited = new Set<string>();
  while (ordered.length < input.tasks.length) {
    const ready = input.tasks.find(
      (task) => !visited.has(task.id) && task.dependsOn.every((id) => visited.has(id)),
    );
    if (!ready) throw new Error("Multitask dependencies contain a cycle");
    ordered.push(ready);
    visited.add(ready.id);
  }
  const activeProfiles = normalizeAgentProfiles(profiles);
  const lines = input.workers.map((worker, index) => {
    const profileName = worker.profile ?? "general-purpose";
    const profile =
      workerProfiles?.get(worker.id) ?? activeProfiles.find((entry) => entry.name === profileName);
    if (!profile) throw new Error(`Unknown Subagent profile: ${profileName}`);
    if (profile.skills?.length || profile.mcpServers !== undefined || profile.memory) {
      throw new Error(
        `Profile ${profileName} requires skills, MCP scoping or memory unsupported in Multitask M1`,
      );
    }
    // "*" 在 persona 层是"不限定"，不能原样进入 toolAllowlist：运行时按**精确工具名**做交集
    // （tool/handlers/index.ts 的 allowedTools.has(name)），字面量 "*" 一个都匹配不上，
    // write worker 的工具面会被清空——表现是模型无工具可用、只回一句开场白就结束 turn。
    // 因此只有 profile 给出具体清单时才写 tools，通配与缺省都表示沿用完整工具面（减去减法表）。
    const concreteProfileTools = profile.tools?.filter((tool) => tool !== "*");
    const tools =
      worker.access === "read"
        ? MULTITASK_READ_TOOLS.filter(
            (tool) => !concreteProfileTools?.length || concreteProfileTools.includes(tool),
          )
        : concreteProfileTools?.length
          ? concreteProfileTools
          : undefined;
    const persona = {
      system: [
        profile.systemPrompt,
        `Role: ${worker.role}`,
        `Objective: ${input.objective}`,
        input.sharedContext ?? "",
        MULTITASK_WORKER_CONTRACT,
      ]
        .filter(Boolean)
        .join("\n\n"),
      worker: {
        profile: profile.name,
        access: worker.access,
        ...(profile.modelSelection ? { modelSelection: profile.modelSelection } : {}),
        ...(tools ? { tools } : {}),
        ...(profile.disallowedTools ? { disallowedTools: profile.disallowedTools } : {}),
        ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
        // profile 未声明 permissionMode 时必须留空：undefined 让既有 subagent 继承规则接管
        // （普通 worker 继承父会话模式，内置 Explore 用 yolo）。写死 "auto" 会命中
        // PermissionService 的 mode.auto.unimplemented 分支，把 worker 的 Read/Grep 全部拒掉。
        ...(profile.permissionMode ? { permissionMode: profile.permissionMode } : {}),
      },
    };
    return `const w${index} = agent(${JSON.stringify(`${worker.id}: ${worker.role}`)}, ${JSON.stringify(persona)});`;
  });
  const variables = new Map<string, string>();
  let writer: string | undefined;
  const lastWorkerTask = new Map<string, string>();
  for (const [index, task] of ordered.entries()) {
    const variable = `t${index}`;
    const isWriter = workers.get(task.worker)!.access === "write";
    // 无 worktree 隔离时 writer 必须独占：所有前驱先结算，后续 reader 也等待 writer。
    const waits = new Set(task.dependsOn.map((id) => variables.get(id)!));
    if (writer) waits.add(writer);
    const previousWorkerTask = lastWorkerTask.get(task.worker);
    if (previousWorkerTask) waits.add(previousWorkerTask);
    if (isWriter) for (const previous of variables.values()) waits.add(previous);
    const worker = workers.get(task.worker)!;
    const workerIndex = input.workers.findIndex((entry) => entry.id === task.worker);
    const ids = `${JSON.stringify(task.id)}, ${JSON.stringify(worker.id)}`;
    const deps = task.dependsOn.map((id) => variables.get(id)!);
    const depResults = task.dependsOn
      .map((id) => `${JSON.stringify(id)}: await ${variables.get(id)!}`)
      .join(", ");
    const prompt = `${JSON.stringify(`Task ${task.id}: ${task.prompt}`)}${task.dependsOn.length ? ` + "\\n\\nDependency results: " + JSON.stringify({${depResults}})` : ""}`;
    const wait = waits.size ? `await Promise.all([${[...waits].join(", ")}]); ` : "";
    // 依赖没做成（blocked / failed / skipped）就不派发：依赖失败绝不静默放行下游。
    const skip = deps.length
      ? `const blockedBy = multitaskBlockedBy([${deps.map((dep) => `await ${dep}`).join(", ")}]); if (blockedBy) return multitaskReport({ task: ${JSON.stringify(task.id)}, worker: ${JSON.stringify(worker.id)}, outcome: "skipped", result: "Not started: dependency " + blockedBy.task + " ended " + blockedBy.outcome }); `
      : "";
    lines.push(
      `const ${variable} = (async (): Promise<MultitaskOutcome> => { ${wait}${skip}try { const value = await w${workerIndex}.ask<MultitaskTaskResult>(${prompt}); return multitaskReport(multitaskJudge(${ids}, ${JSON.stringify(worker.access)}, value)); } catch (error) { return multitaskReport(multitaskFailed(${ids}, error)); } })();`,
    );
    variables.set(task.id, variable);
    lastWorkerTask.set(task.worker, variable);
    if (isWriter) writer = variable;
  }
  lines.push(`await Promise.all([${[...variables.values()].join(", ")}]);`);
  lines.push(
    `return {${ordered.map((task) => `${JSON.stringify(task.id)}: await ${variables.get(task.id)!}`).join(", ")}};`,
  );
  return [MULTITASK_PRELUDE, ...lines].join("\n");
}
