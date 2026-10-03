import type { MultitaskInput } from "@zcode/contracts";
import { normalizeAgentProfiles, type AgentProfile } from "../../subagent/profile.js";

// 共享工作区中只读并发必须由工具边界保证，Bash/REPL/MCP 不能靠提示词证明只读。
export const MULTITASK_READ_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

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
    const depResults = task.dependsOn
      .map((id) => `${JSON.stringify(id)}: await ${variables.get(id)!}`)
      .join(", ");
    const prompt = `${JSON.stringify(`Task ${task.id}: ${task.prompt}`)}${task.dependsOn.length ? ` + "\\n\\nDependency results: " + JSON.stringify({${depResults}})` : ""}`;
    const workerIndex = input.workers.findIndex((worker) => worker.id === task.worker);
    const wait = waits.size ? `await Promise.all([${[...waits].join(", ")}]); ` : "";
    lines.push(
      `const ${variable} = (async () => { ${wait}return await w${workerIndex}.ask(${prompt}); })();`,
    );
    variables.set(task.id, variable);
    lastWorkerTask.set(task.worker, variable);
    if (isWriter) writer = variable;
  }
  lines.push(`await Promise.all([${[...variables.values()].join(", ")}]);`);
  lines.push(
    `return {${ordered.map((task) => `${JSON.stringify(task.id)}: await ${variables.get(task.id)!}`).join(", ")}};`,
  );
  return lines.join("\n");
}
