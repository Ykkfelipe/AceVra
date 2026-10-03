---
name: parallel-cua-workbreakdown
description: "Use when decomposing an AceVra task into parallel subagents: which roles fan out, which steps are machine-global serial points, the self-contained handoff template, fences, and per-subagent verification duties. Pairs with the cua-system-map, cua-live-acceptance, and alpha-packaging-release playbooks."
---

# Parallel subagent decomposition for AceVra work

Main-agent job: split work, hand each subagent a SELF-CONTAINED prompt (they start with
zero memory of this conversation), keep serial points to yourself, merge + verify. Subagents
should be told to READ the relevant playbook first:
`.agents/skills/<name>/SKILL.md` (cua-system-map / cua-live-acceptance /
alpha-packaging-release / this one).

## 0. ZCode-native parallel runners (saved workflows)

Three saved dynamic workflows in `.zcode/workflows/` already encode the common fan-outs —
run them by name (`CreateWorkflow` with `saved: { name, args }`) instead of hand-spawning:

- `cua-explore` — N read-only mapper subagents over `{ questions: string[] }` → cited report.
- `cua-gates` — this repo's standard verification gates in parallel (`{ suites?: string[] }`)
  → per-gate pass/fail table with failure evidence.
- `cua-implement-split` — parallel implementers with hard per-task file fences
  (`{ tasks: [{name, instructions, files}] }`) → shared gates + one bounded fix round.

Prefer them for their shapes; fall back to manual `Agent` fan-out only when the shape
doesn't fit. Anything machine-global (packaging, live runs, commits) stays with the main
agent regardless (§2).

## 1. What fans out safely (parallel)

| Role                      | Type                               | Scope                                                                      |
| ------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Mapper                    | Explore / Investigator (read-only) | trace a chain, inventory call sites, produce a file:line map. No edits.    |
| Package-owner implementer | general-purpose                    | ONE package or disjoint file set + its deterministic tests                 |
| Test author               | general-purpose                    | new `node --test` / render tests against fakes (no app, no Helper)         |
| Docs/spec                 | general-purpose                    | `specs/*.md`, skill docs, i18n strings                                     |
| Log/evidence miner        | general-purpose                    | read-only sweep of `~/.zcode-local-engineering-alpha/.zcode/v2/logs/*.log` |

Independent seams that parallelize well (one owner per seam):
`packages/zcode-cua` (runtime/bridge) · `packages/services` cua-permission-broker ·
`packages/ui` (components/hooks/store/lib) · `packages/shared` (test-ids/protocol) ·
`apps/zcode-cli/packages/node-repl-host` · specs/skills. Shared touchpoints that FORCE
serialization: `packages/shared/src/test-ids.ts`, `packages/zcode-cua/broker.d.ts`,
`packages/services/src/index.ts` re-export block, i18n locale files, and any
`.d.ts` — assign them to exactly ONE subagent or take them yourself.

## 2. Machine-global serial points (never parallelize)

- Packaging/install (fixed dirs, replaces /Applications, quits the app, one rollback).
- Live acceptance runs (share screen/focus/fixture/Helper; two runners break zero-steal).
- `git commit`/`push` (one commit per accepted milestone; the main agent commits).
- Any step that restarts AceVra or the Helper.

## 3. Handoff template (fill every bracket; subagents cannot ask questions)

```text
REPO: /Users/felipemore/Projects/AceVra   BRANCH: release/0.1.0-alpha   HEAD: <sha>
FIRST: Read .agents/skills/<playbook>/SKILL.md and verify claims against current HEAD.
MISSION: <one paragraph; the deliverable, stated as done-when>
IN SCOPE: <exact files/dirs>
OUT OF SCOPE / DO NOT TOUCH: <accepted behaviors, other seams, .spike unless evidence>
COMMANDS (run from repo root): <exact mise/pnpm invocations>
VERIFICATION YOU MUST RUN AND REPORT HONESTLY: <targeted suites, typecheck, arch:check, lint/fmt>
EVIDENCE: <where to write it, e.g. .spike/perception/evidence/<run>/ — .spike stays untracked>
RETURN: numbered list — <facts/decisions/shas/test counts>, plus any deviation from scope.
STOP CONDITIONS: <e.g. genuine product defect → stop and report; no retries beyond N>
HARD RULES: no merge/tag/push; no production code beyond scope; secrets/socket values never printed.
```

## 4. Merge duties (main agent)

1. Re-verify each subagent's claims cheaply: run the targeted suites yourself; spot-read
   diffs for scope creep (`git diff --stat`).
2. Resolve shared-touchpoint conflicts in ONE place (test-ids, broker.d.ts, re-exports).
3. Full gates once after merge: root typecheck + `pnpm --dir apps/zcode-cli -r typecheck` +
   `pnpm architecture:check --changed` + scoped lint/fmt + all touched suites +
   `git diff --check`.
4. Spec first, then code: behavior changes update the spec in the same change
   (AGENTS.md rule); the commit message follows the deck (`feat(cua): …`, `fix(cua): …`).
5. Only after gates: packaging (alpha-packaging-release playbook), then live acceptance
   (cua-live-acceptance playbook) — these two are serial by nature.

## 5. Anti-patterns observed in this project (do not repeat)

- Two surfaces editing the same projection/store in one milestone — state ownership drifted;
  assign the projection to one owner (see cua-system-map §3).
- A subagent "fixing" an accepted behavior (Notes AX refusal, safety-bar rule) — accepted
  behaviors are listed in cua-system-map §7 and are out of scope by default.
- Silent install failures and stale Helper processes wasting a debug cycle — follow
  alpha-packaging-release §2 checks.
- Parallel live runs double-hitting the fixture — zero-steal evidence became invalid; live
  work is strictly serial.
- Reused acceptance case ids matching ghost transcript records — always nonce them.
