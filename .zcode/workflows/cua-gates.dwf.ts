/* zcode-workflow
description: Runs this repo's standard verification gates in parallel (root/CLI
  typecheck, architecture check, zcode-cua + UI + services test suites) and
  reports a per-gate pass/fail table with failure evidence.
whenToUse: Use before committing or after merging parallel work when you want
  every standard gate checked at once instead of serially.
args:
  suites:
    type: json
    description: "Optional subset of gate names: typecheck-root, typecheck-cli,
      arch-changed, tests-cua, tests-ui, tests-services. Empty array or omitted
      = run all."
    required: false
    default: []
*/
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
  title: "Verification gates",
  columns: [
    { field: "gate", label: "Gate" },
    { field: "status", label: "Result" },
    { field: "detail", label: "Detail" },
  ],
  key: "gate",
});

const raw = Array.isArray(args.suites) ? args.suites : [];
const selected = raw.map((s) => String(s));
const want = (name: string) => selected.length === 0 || selected.includes(name);

const uiFiles = [
  "packages/ui/test/cuaSessionBar.test.ts",
  "packages/ui/test/cuaUiState.test.ts",
  "packages/ui/test/computerActionLabel.test.ts",
  "packages/ui/test/miniComputerPanel.test.ts",
];
const serviceFiles = [
  "packages/services/test/workspaceProjection.test.ts",
  "packages/services/test/leaseAuthorityServer.test.ts",
];

const gates: { name: string; argv: string[]; timeoutMs: number }[] = [];
if (want("typecheck-root")) {
  gates.push({
    name: "typecheck-root",
    argv: ["exec", "--", "node", "scripts/mise-run.mjs", "pnpm", "typecheck"],
    timeoutMs: 900000,
  });
}
if (want("typecheck-cli")) {
  gates.push({
    name: "typecheck-cli",
    argv: ["exec", "--", "pnpm", "--dir", "apps/zcode-cli", "-r", "typecheck"],
    timeoutMs: 900000,
  });
}
if (want("arch-changed")) {
  gates.push({
    name: "arch-changed",
    argv: ["exec", "--", "pnpm", "architecture:check", "--changed"],
    timeoutMs: 600000,
  });
}

if (gates.length === 0) {
  return {
    conclusion:
      "No gates selected. Valid names: typecheck-root, typecheck-cli, arch-changed, tests-cua, tests-ui, tests-services. Pass args.suites as an array of names, or omit it for all.",
    findings: [],
    verified: [],
    notCovered: ["nothing ran"],
  };
}

phase("Run the selected verification gates in parallel");
const cuaTestFiles = await files.glob("packages/zcode-cua/test/*.test.mjs");
if (want("tests-cua") && cuaTestFiles.length > 0) {
  gates.push({
    name: "tests-cua",
    argv: ["exec", "--", "node", "--test", ...cuaTestFiles],
    timeoutMs: 600000,
  });
}
if (want("tests-ui")) {
  gates.push({
    name: "tests-ui",
    argv: [
      "exec",
      "--",
      "env",
      "TSX_TSCONFIG_PATH=packages/ui/tsconfig.json",
      "node",
      "--import",
      "tsx",
      "--test",
      ...uiFiles,
    ],
    timeoutMs: 600000,
  });
}
if (want("tests-services")) {
  gates.push({
    name: "tests-services",
    argv: [
      "exec",
      "--",
      "env",
      "TSX_TSCONFIG_PATH=packages/services/tsconfig.json",
      "node",
      "--import",
      "tsx",
      "--test",
      ...serviceFiles,
    ],
    timeoutMs: 600000,
  });
}
log(`Running ${gates.length} gates in parallel: ${gates.map((g) => g.name).join(", ")}`);

const results = await Promise.all(
  gates.map((g) =>
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
  ),
);

const failures = results.filter((r) => r.status === "fail");
const findings: Finding[] = failures.map((f) => ({
  where: `gate ${f.gate}`,
  what: `Verification gate failed: ${f.gate}`,
  evidence: f.detail,
  status: "verified",
  severity: "high",
}));

const markdown = [
  "# Verification report",
  "",
  ...results.map((r) =>
    r.status === "pass"
      ? `- **${r.gate}**: pass`
      : `- **${r.gate}**: FAIL\n\n  \`\`\`\n  ${r.detail}\n  \`\`\``,
  ),
].join("\n");
await artifact.markdown("report", markdown, {
  title: "Verification report",
  description: `${results.length - failures.length}/${results.length} gates passed.`,
  primary: true,
});
return {
  conclusion:
    failures.length === 0
      ? `All ${results.length} selected gates passed.`
      : `${failures.length} of ${results.length} gates failed: ${failures.map((f) => f.gate).join(", ")}.`,
  findings,
  verified: results.map((r) => `${r.gate}: ${r.status}`),
  notCovered: ["gates not selected were not run"],
};
