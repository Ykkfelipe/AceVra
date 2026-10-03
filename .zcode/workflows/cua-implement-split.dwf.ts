/* zcode-workflow
description: Runs parallel implementer subagents over disjoint tasks (hard
  per-task file fences), then shared repo gates (root/CLI typecheck,
  architecture check, zcode-cua tests) with one bounded fix round, and delivers
  an implementation report.
whenToUse: Use when a milestone decomposes into parallel edits across disjoint
  file seams (e.g. one implementer per package) and you want shared gates + a
  bounded fix round after the fan-out.
args:
  tasks:
    type: json
    description: Array of {name, instructions, files[]} — one entry per parallel
      implementer; files[] is the hard edit fence for that implementer.
    required: true
*/
interface ImplNote {
  /** What was done, one paragraph. */
  summary: string;
  /** Files actually edited (workspace-relative). */
  filesChanged: string[];
  /** Targeted tests/commands run and their outcomes (honest: what was and was not run). */
  verification: string;
}
interface GateResult {
  /** Gate name. */
  gate: string;
  /** Outcome of the gate command. */
  status: "pass" | "fail";
  /** "exit 0" on success; the tail of stderr/stdout on failure. */
  detail: string;
}
interface Finding {
  /** Workspace-relative path, with a line when it applies. */
  where: string;
  /** One sentence: what was found. */
  what: string;
  /** What showed it. */
  evidence: string;
  /** "verified" when independently confirmed; "unconfirmed" otherwise. */
  status: "verified" | "unconfirmed";
  /** How much it matters. */
  severity: "low" | "medium" | "high";
}
interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

artifact.table("gates", {
  title: "Shared gates",
  columns: [
    { field: "gate", label: "Gate" },
    { field: "status", label: "Result" },
    { field: "detail", label: "Detail" },
  ],
  key: "gate",
});

const raw = Array.isArray(args.tasks) ? args.tasks : [];
const tasks: { name: string; instructions: string; files: string[] }[] = [];
for (const t of raw) {
  if (typeof t === "object" && t !== null) {
    const o = t as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    const instructions = String(o.instructions ?? "").trim();
    const files = Array.isArray(o.files) ? o.files.map((f) => String(f)) : [];
    if (name && instructions && files.length > 0) tasks.push({ name, instructions, files });
  }
}
if (tasks.length === 0) {
  return {
    conclusion: "No tasks provided: pass args.tasks as [{name, instructions, files}].",
    findings: [],
    verified: [],
    notCovered: ["nothing ran"],
  };
}

phase("Implement the disjoint tasks in parallel");
log(`${tasks.length} implementers started`);
const notes = await Promise.all(
  tasks.map((t, i) =>
    agent(`Implementer ${i + 1} - ${t.name}`, {
      system:
        "You are a senior engineer on this repository working on ONE disjoint seam. " +
        "Edit ONLY the files you were assigned. Before coding, read " +
        ".agents/skills/cua-system-map/SKILL.md (system map) and " +
        ".agents/skills/parallel-cua-workbreakdown/SKILL.md (fences and conventions). " +
        "Follow repo conventions (Chinese comments for bug-fix rationale per AGENTS.md). " +
        "Report honestly what you verified and what you did not; if your task is impossible, " +
        "contradictory, or overlaps another owner's files, escalate instead of expanding scope.",
    }).ask<ImplNote>(
      `Task: ${t.instructions}\n\n` +
        `You may edit ONLY these files: ${t.files.join(", ")}\n` +
        "Run the targeted tests for your change and record the exact commands and outcomes. " +
        "Do NOT run the full typecheck or other owners' suites - the workflow runs shared gates after you. " +
        "Do NOT commit. Return: summary, files changed, verification.",
    ),
  ),
);

phase("Run shared gates, then one bounded fix round");
const cuaTestFiles = await files.glob("packages/zcode-cua/test/*.test.mjs");
const runGates = (): Promise<GateResult>[] => {
  const gates: { name: string; argv: string[]; timeoutMs: number }[] = [
    {
      name: "typecheck-root",
      argv: ["exec", "--", "node", "scripts/mise-run.mjs", "pnpm", "typecheck"],
      timeoutMs: 900000,
    },
    {
      name: "typecheck-cli",
      argv: ["exec", "--", "pnpm", "--dir", "apps/zcode-cli", "-r", "typecheck"],
      timeoutMs: 900000,
    },
    {
      name: "arch-changed",
      argv: ["exec", "--", "pnpm", "architecture:check", "--changed"],
      timeoutMs: 600000,
    },
  ];
  if (cuaTestFiles.length > 0) {
    gates.push({
      name: "tests-cua",
      argv: ["exec", "--", "node", "--test", ...cuaTestFiles],
      timeoutMs: 600000,
    });
  }
  return gates.map((g) =>
    world.run("mise", g.argv, { timeoutMs: g.timeoutMs }).then((r) => {
      const ok = r.exitCode === 0;
      const item: GateResult = {
        gate: g.name,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `exit 0 (${r.stdout.trim().split("\n").pop() ?? ""})`
          : (r.stderr.trim() || r.stdout.trim()).slice(-1200),
      };
      report(item, "gates");
      return item;
    }),
  );
};

let gateResults = await Promise.all(runGates());
let fixRounds = 0;
while (gateResults.some((g) => g.status === "fail") && fixRounds < 2) {
  fixRounds += 1;
  const failures = gateResults.filter((g) => g.status === "fail");
  const fixer = agent(`Fixer round ${fixRounds}`);
  await fixer.ask(
    `These shared gates failed:\n${JSON.stringify(failures, null, 1)}\n` +
      "Fix the failures in the working tree. Stay within the seam the failing gate points at; " +
      "do not revert other implementers' work. Do NOT re-run the gates yourself - the workflow " +
      "re-runs them next. Return one sentence on what you changed.",
  );
  gateResults = await Promise.all(runGates());
}

const remaining = gateResults.filter((g) => g.status === "fail");
const findings: Finding[] = remaining.map((f) => ({
  where: `gate ${f.gate}`,
  what: `Shared gate still failing after ${fixRounds} fix round(s): ${f.gate}`,
  evidence: f.detail,
  status: "verified",
  severity: "high",
}));

const markdown = [
  "# Parallel implementation report",
  "",
  ...notes.map((n, i) =>
    [
      `## ${tasks[i]?.name ?? `task ${i + 1}`}`,
      "",
      n.summary,
      "",
      `Files: ${n.filesChanged.join(", ") || "-"}`,
      "",
      `Verification: ${n.verification}`,
    ].join("\n"),
  ),
  "",
  "## Shared gates",
  ...gateResults.map((g) =>
    g.status === "pass"
      ? `- **${g.gate}**: pass`
      : `- **${g.gate}**: FAIL\n\n  \`\`\`\n  ${g.detail}\n  \`\`\``,
  ),
].join("\n");
await artifact.markdown("report", markdown, {
  title: "Implementation report",
  description: `${tasks.length} parallel implementers + shared gates (${fixRounds} fix rounds).`,
  primary: true,
});
return {
  conclusion:
    remaining.length === 0
      ? `All ${tasks.length} tasks implemented and the shared gates pass.`
      : `${tasks.length} tasks implemented; ${remaining.length} shared gate(s) still failing after ${fixRounds} fix round(s): ${remaining.map((f) => f.gate).join(", ")}.`,
  findings,
  verified: gateResults.map((g) => `${g.gate}: ${g.status}`),
  notCovered: [
    "each implementer's own targeted tests as reported by them (not independently re-run)",
    "commit and push are not performed by this workflow",
  ],
};
