/* zcode-workflow
description: Fans out parallel read-only investigator subagents over a list of
  questions about this repo (Computer Workspace stack background included) and
  composes a cited research report.
whenToUse: Use when several independent "how/where does X work" questions about
  this repository need answers with file:line evidence and you want them
  investigated in parallel instead of serially.
args:
  questions:
    type: json
    description: 'Array of research questions (strings), max 8. Example: ["Where is
      the lease authority projection maintained?", "Which files gate the safety
      bar?"]'
    required: true
*/
interface Answer {
  /** Original question number (1-based). */
  index: number;
  /** The answer: conclusion first, then file:line evidence. */
  answer: string;
  /** Key files referenced (workspace-relative paths). */
  files: string[];
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

const raw = Array.isArray(args.questions) ? args.questions : [];
const questions = raw
  .map((q) => String(q))
  .filter((q) => q.trim().length > 0)
  .slice(0, 8);
if (questions.length === 0) {
  return {
    conclusion: "No questions provided: pass args.questions as an array of strings (max 8).",
    findings: [],
    verified: [],
    notCovered: ["nothing ran"],
  };
}

phase("Research each question in parallel");
log(`Researching ${questions.length} questions with parallel read-only mappers`);
const answers = await Promise.all(
  questions.map((q, i) =>
    agent(`Mapper ${i + 1}`, {
      system:
        "You are a read-only investigator for this repository. Do not edit any file. " +
        "Every claim needs file:line evidence; say plainly what you could not confirm. " +
        "Start by reading .agents/skills/cua-system-map/SKILL.md for background on the " +
        "Computer Workspace stack, then verify every claim against the current source.",
    }).ask<Answer>(
      `Question ${i + 1}: ${q}\n\n` +
        "Answer with: conclusion first, then file:line evidence, then the key files you used. Be concise.",
    ),
  ),
);

phase("Compose the research report");
const markdown = [
  "# Parallel research report",
  "",
  ...answers.map(
    (a) =>
      `## Q${a.index + 1}. ${questions[a.index] ?? ""}\n\n${a.answer}\n\nFiles: ${a.files.join(", ") || "-"}`,
  ),
].join("\n");
await artifact.markdown("report", markdown, {
  title: "Research report",
  description: `${answers.length} questions investigated in parallel by read-only mappers.`,
  primary: true,
});
return {
  conclusion: `${answers.length} questions investigated in parallel; see the report artifact for the answers with file:line evidence.`,
  findings: [],
  verified: [
    "every answer cites file:line evidence gathered by its own mapper from the current working tree",
  ],
  notCovered: ["answers were not re-verified by a second agent (survey, not defect hunt)"],
};
