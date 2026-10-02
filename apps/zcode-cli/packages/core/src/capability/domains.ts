// 能力域的静态数据：原生工具 → 域、相关性词表、域 → Skill 提示。
// 纯数据，无 I/O；修改这里即修改确定性相关性规则（core/specs/capability-runtime.md）。
import type { CapabilityDomain } from "@zcode/contracts";

export interface NativeDomainSpec {
  id: string;
  domain: CapabilityDomain;
  displayName: string;
  tools: readonly string[];
  /** provider 工具表已含其 schema：可用时提醒中不重复描述，只在不可用/重定向时出现。 */
  alwaysVisible: boolean;
}

export const NATIVE_DOMAIN_SPECS: readonly NativeDomainSpec[] = [
  {
    id: "native.files",
    domain: "files",
    displayName: "Files (this Mac)",
    tools: ["Read", "Write", "Edit", "NotebookEdit", "apply_patch"],
    alwaysVisible: true,
  },
  {
    id: "native.search",
    domain: "search",
    displayName: "Code search (this Mac)",
    tools: ["Glob", "Grep", "LSP"],
    alwaysVisible: true,
  },
  {
    id: "native.shell",
    domain: "shell",
    displayName: "Shell (Bash)",
    tools: ["Bash", "TaskOutput", "TaskStop"],
    alwaysVisible: true,
  },
  {
    id: "native.web",
    domain: "web",
    displayName: "Web fetch and search",
    tools: ["WebFetch", "WebSearch"],
    alwaysVisible: true,
  },
  {
    id: "native.planning",
    domain: "planning",
    displayName: "Planning and questions",
    tools: ["TodoWrite", "TodoRead", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion"],
    alwaysVisible: true,
  },
  {
    id: "native.skills",
    domain: "skills",
    displayName: "Skills",
    tools: ["Skill"],
    alwaysVisible: true,
  },
  {
    id: "native.agents",
    domain: "agents",
    displayName: "Subagents",
    tools: ["Agent", "Task", "SendMessage", "RespondToCoordinator"],
    alwaysVisible: true,
  },
  {
    id: "native.scheduling",
    domain: "scheduling",
    displayName: "Scheduling",
    tools: ["CronCreate", "CronList", "CronUpdate", "CronDelete", "OffPeakCreate", "OffPeakList"],
    alwaysVisible: true,
  },
  {
    id: "native.workflow",
    domain: "workflow",
    displayName: "Workflows",
    tools: [
      "Workflow",
      "CreateWorkflow",
      "AmendWorkflow",
      "SaveWorkflow",
      "ListSavedWorkflows",
      "EvalWorkflowSnippet",
      "ListWorkflowRuns",
      "GetWorkflowRun",
      "ResumeWorkflowRun",
      "ResolveWorkflowQuestion",
      "ListModels",
      "submit_result",
      "escalate",
    ],
    alwaysVisible: true,
  },
  {
    id: "native.node_repl",
    domain: "other",
    displayName: "JavaScript REPL (node_repl)",
    tools: ["js"],
    alwaysVisible: true,
  },
];

export const EXECUTION_TARGET_TOOLS = ["ExecutionTargets", "RunOnTarget", "TargetTask"] as const;
export const REMOTE_COMPUTER_TOOL = "RemoteComputer";
export const NODE_REPL_TOOL = "js";
export const THIS_DEVICE_TARGET = "this-device";
export const CAPABILITIES_TOOL = "Capabilities";

/** 由专门投影（执行目标 / 远程电脑）或元工具认领、不进入 native.other 的工具名。 */
export const CAPABILITY_META_TOOLS: ReadonlySet<string> = new Set([
  CAPABILITIES_TOOL,
  REMOTE_COMPUTER_TOOL,
  ...EXECUTION_TARGET_TOOLS,
]);

/**
 * 相关性词表（小写、按词边界匹配）。刻意偏具体：泛词（"app"、"node"、"background"）
 * 在编码语境误命中率高，宁可漏选（模型仍可调 Capabilities 工具）也不每轮注入。
 */
export const DOMAIN_LEXICON: Readonly<Partial<Record<CapabilityDomain, readonly string[]>>> = {
  computer: [
    "computer use",
    "chrome",
    "google chrome",
    "safari",
    "finder",
    "textedit",
    "system settings",
    "system preferences",
    "app store",
    "notes app",
    "desktop app",
    "native app",
    "mac app",
    "macos app",
    "on my mac",
    "on this mac",
    "in the background",
    "background computer",
    "click the",
    "click on",
    "type into",
    "电脑操作",
    "桌面应用",
    "打开应用",
    "后台打开",
  ],
  browser: [
    "browser tab",
    "in-app browser",
    "web page",
    "webpage",
    "website",
    "localhost",
    "headless browser",
    "playwright",
    "浏览器",
    "网页",
  ],
  remote_computer: [
    "remote computer",
    "my other computer",
    "another computer",
    "other machine",
    "my pc",
    "windows pc",
    "on my laptop",
    "over ssh",
    "my dell",
    "my thinkpad",
    "my lenovo",
    "my windows machine",
    "my windows computer",
    "my linux machine",
    "my raspberry pi",
    "my server",
    "另一台电脑",
    "远程电脑",
  ],
  execution_targets: [
    "acevra node",
    "execution target",
    "run on my",
    "remote machine",
    "另一台电脑",
  ],
  files: [
    "pdf",
    "docx",
    "word document",
    "xlsx",
    "spreadsheet",
    "pptx",
    "slide deck",
    "presentation",
  ],
};

/** 显式本机意图：与远程目标同时出现时，本地 Computer 仍保留。 */
export const LOCAL_ONLY_KEYWORDS: readonly string[] = ["this mac", "on my mac", "locally", "本机"];

/** 域 → 讲用法的 Skill 名（按 name 或 qualifiedName 末段匹配已发现的 Skill）。 */
export const DOMAIN_SKILL_HINTS: Readonly<Partial<Record<CapabilityDomain, readonly string[]>>> = {
  computer: ["computer-use"],
  browser: ["control-browser"],
  // 文档类 Skill：快照层全部关联，渲染层只保留与本轮命中关键词同名的那个（pdf → pdf）。
  files: ["pdf", "docx", "xlsx", "pptx"],
};

export function nativeDomainSpecForTool(toolName: string): NativeDomainSpec | undefined {
  return NATIVE_DOMAIN_SPECS.find((spec) => spec.tools.includes(toolName));
}
