# Multitask M2 handoff

Written 2026-10-03 after the M2 implementation and live acceptance pass.

| Item | Value |
| --- | --- |
| Branch | `feature/multitask-m2` (pushed to `origin`) |
| Worktree | `/Users/felipemore/Projects/AceVra-multitask-m2` |
| Base | `d25f031` — accepted M1 head |
| M2 code commits | `87ec95c` runtime semantics, `d95741b` worker-first UI |
| Handoff commit | the commit that adds this file (top of the branch) |
| M2 status | **Accepted live** — all M2 scenarios and M1 regressions passed |

## Branch isolation (read this first)

After M1 was frozen at `d25f031`, two unrelated cross-mode integration commits
landed on `feature/multitask` from another session while M2 was in progress:

- `aabd8a8` chore(shared): sync frozen cross-mode contract snapshot (b5b4ca1)
- `ef14646` feat(multitask): adopt cross-mode handoff contract

They were not part of the M2 brief ("do not integrate sibling branches yet")
and they break the desktop dev build: the CLI bundler cannot resolve the new
`@zcode/shared/cross-mode` subpath (esbuild alias maps `@zcode/shared` to
`src/index.ts`, so `…/index.ts/cross-mode` fails). To preserve the accepted
baseline, M2 was **isolated on `feature/multitask-m2` from `d25f031`**. The two
commits were left exactly as-is on `feature/multitask` for later
investigation; nothing was reverted, rewritten or merged. The cross-mode
bundling problem does **not** exist on this branch and was not fixed here. It
belongs to the cross-feature integration pass.

Verified: `feature/multitask-m2` contains M1 through `d25f031` plus the M2
commits, and neither `aabd8a8` nor `ef14646`.

## UI behavior

Multitask runs render **worker-first** in the turn digest card; the phase
timeline remains in the run-details pane as the advanced view. Normal Workflow
runs keep the timeline.

- One row per worker: colored face, role, `Read-only` / `Writes` badge, state
  word, and a detail line.
- Live: `Working` with the current action (`Bash node --test m2a/pricing.test.mjs
  · 3 tool calls`), `Waiting for its turn or dependencies`, or `Submitting`
  (turn ended without a result; nudged).
- Settled: outcome plus objective evidence (`1 file changed · 1 command run · 4
  tool calls`). `Unverified` ("Claimed done, but no tool use was observed"),
  `No changes`, `Blocked`, `Failed`, `Skipped`, `Stopped` are visually distinct
  from `Done` (success/warning/destructive/muted semantic tokens).
- Tasks replayed from the journal on resume show a `Reused` badge.
- A row expands to per-task outcome, submitted result text, changed file names,
  and `Open transcript` (same actor-pane path as the timeline pills).
- Coordinator output stays in the normal message flow; the card is the run
  surface. Stop / Resume / Configure / ⤢ are unchanged.
- Header and completion card say `Multitask running/completed/stopped`.

## Completion-state semantics

Spec: `apps/zcode-cli/packages/core/specs/multitask.md` (section Multitask M2).

- Every task is a **typed ask**: `{status: "done" | "blocked", result}`. A turn
  that ends without `submit_result` is nudged once, then fails with
  `ResultNotSubmitted`. Execution completion ≠ assignment success.
- **Evidence owner = driver.** At the submit bridge the driver overwrites
  `evidence` with counts observed from `ToolCallStarted`: `toolCalls`,
  `worldToolCalls`, `mutatingToolCalls`, `commandCalls`, `filesChanged`.
  Model-authored evidence is discarded. Only Multitask personas are stamped.
  Evidence is in the accepted, journaled result and replays on resume.
- **Outcome owner = lowered script** (deterministic, replay-stable):
  `done` (reader ≥1 world call / writer ≥1 mutating call), `done_no_changes`,
  `unverified` (zero world calls), `blocked`, `failed`, `skipped` (dependency
  blocked/failed/skipped, never dispatched). `Cancelled`, `ProviderStop` and
  `Interrupted` propagate so the run stops resumable.
- Each outcome is `report()`ed (journaled, deduplicated on resume) and returned
  by task ID. The coordinator is told only `done` is evidence-backed.
  Coordinator verification remains a backstop. No chain-of-thought is exposed:
  only submitted results and runtime counts.

## Live evidence

AceVra Dev from `feature/multitask-m2`, profile `~/.zcode-acevra-dev`, Z.ai
`GLM-5.3-Flash` reasoning Low, `ZCODE_DYNAMIC_WORKFLOW_MODE=alwaysOn`. Fixture:
untracked `.spike/multitask-m1-live/fixture/{m2a,m2b}`. Screenshots and journal
extracts are in `.spike/multitask-m2-live/evidence/` (not committed). Journal:
`~/.zcode/cli/db/db.sqlite` (`dwf_event`). Model IO:
`~/.zcode-acevra-dev/.zcode/cli/debug/model-io-sess_dwf-<run>-actor_N_1.jsonl`.

| # | Scenario | Run | Result |
| --- | --- | --- | --- |
| 1 | explorer → builder → verifier, implement `discountTotal` | `dwfrun-e32d629f` | **PASS** — all Done; builder `1 file changed · 1 command run · 4 tool calls`; tests 3/3 re-run independently; coordinator cited the file-change evidence |
| 2 | Resume reuse (A done, B active, stop, resume) | `dwfrun-657c0819` | **PASS** — see below |
| 3 | Tool-less claim | `dwfrun-b42c1192` (oracle) | **PASS** — `Unverified`, "Claimed done, but no tool use was observed" |
| 4 | Writer exclusivity, no declared deps | `dwfrun-b42c1192` | **PASS** — writer queued only after the reader settled (seq 10→14); next reader only after writer settled (19→23) |
| 5 | Reader concurrency | `dwfrun-657c0819` | **PASS** — two read workers `Working` at once, `2 agents working` |
| 6 | No orchestration-tool leakage | e32d629f, 657c0819 | **PASS** — readers: `Glob Grep Read WebFetch WebSearch escalate submit_result`; writer has no Agent/Task/Workflow/Multitask/CreateWorkflow/AmendWorkflow/ResumeWorkflowRun/SaveWorkflow/AskUserQuestion/EnterPlanMode |
| 7 | Normal Workflow regression | `dwfrun-005c58ac` | **PASS** — "Run this workflow?" gate, completed 1/1, timeline UI, header "Workflow completed", 0 reports, no worker persona, result has no `evidence` |
| 8 | Cancellation / resume | `dwfrun-657c0819` | **PASS** — Stop → `stopped/user`, finished worker stays Done, interrupted worker `Stopped`; Resume completes |

### Resume-reuse evidence (`dwfrun-657c0819-757f-44c1-9c2c-9c7bdf02e1c3`)

Stopped 03:28:24 when `quick=done`, `slow=working (Glob .zcode/workflow-drafts/**/*)`;
resumed 03:28:44.

- Model level: `actor_1_1` (quick) = **2 model calls, last 03:28:22**, i.e.
  before stop and resume; zero requests after resume. `actor_2_1` (slow) grew
  from 2 to 20 calls, last 03:32:00.
- Runtime journal (`dwf_event`):
  - life 1: `node-settled ask#1 ok` (seq 14), `report quick done` (17),
    `node-settled ask#2 cancelled` (18), `run-settled stopped user` (19)
  - life 2: `run-started` (20), **`node-settled ask#1 ok cached:true`** (24, no
    `node-queued` for ask#1), `node-queued ask#2` (25), `node-settled ask#2 ok`
    (48), single new `report slow done` (51), `run-settled completed` (52)
- UI: quick row `Reused · Done · 2 tool calls`; slow `Done · 17 tool calls`.

## Bugs found and fixed

1. **Read workers could not submit results** (M2, found live, fixed in
   `87ec95c`). The first live run recorded the explorer as `ResultNotSubmitted`
   and correctly skipped the builder/verifier. The model-io trace showed the
   reader's `toolNames` = `Glob Grep Read WebFetch WebSearch`, with no
   `submit_result`. The read-worker allowlist (fine under M1 untyped asks) intersected away the
   Workflow protocol tools. Fix: allowlists always keep `submit_result` and
   `escalate`. Regression test in `bootstrap/test/multitask-runtime.test.ts`.
   Re-verified live (scenario 1 readers submit; tool surfaces above).
2. **Stale "current action"** (M2 UX, found live). A worker task is usually
   one long turn and `node-progress` was only emitted at turn end, so the card
   showed `Thinking · 0 tool calls` while the worker was busy. Multitask
   workers now emit `node-progress` per started tool (normal Workflow
   unchanged). Unit-tested; verified live (scenario 1 builder action line).
3. Header/completion card said "Workflow" for Multitask runs; now "Multitask".

The first live run also showed the M2 semantics doing their job before the fix:
a non-submitting worker became `failed`, dependents `skipped`, and the run
completed honestly instead of reporting 3/3.

## Validation

- Multitask suites: **26 passed** (core 11, bootstrap runtime 7 + evidence 2,
  UI 6). Run with the M1 resolver:
  `mise exec -- node --experimental-transform-types --import ./.spike/multitask-m1-live/ts-resolve.mjs --test <files>`
  and `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/multitask.test.tsx`.
- `pnpm typecheck`: passed. `@zcode/{core,bootstrap,contracts,dynamic-workflow}` typecheck: passed.
- `pnpm lint`: 0 errors, 86 warnings (same as M1 baseline).
- Touched bootstrap/core files pass oxlint; remaining bootstrap max-lines
  errors are pre-existing in untouched files. `workflow-driver.ts` was kept
  under the 400-line gate by moving `closeActorRuntime` into
  `workflow-driver-helpers.ts` (no behavior change).
- `pnpm architecture:check --changed`: 0 violations. `git diff --check`: clean.
- No packaging, DMG/ZIP, `/Applications/AceVra.app` or Computer Use changes.

## Remaining gaps

1. **Evidence is activity, not correctness.** `done` means the worker declared
   done and acted (read / mutated). It does not prove the change is right;
   the verifier worker and coordinator remain the correctness backstop.
2. Writer evidence counts any workspace-mutating call, including shell commands
   the Bash analyzer cannot prove read-only (e.g. `node --test`). A writer that
   only ran tests reads as `done` with `N workspace changes`, not `files changed`.
3. Model-side non-submission still happens (scenario 1's first run, before the
   allowlist fix, and possible at Low reasoning). It is now surfaced as
   `failed` + `skipped` instead of silent success. The coordinator then tends to
   `AmendWorkflow` the run into a generic Workflow script; amended runs keep the
   worker personas but no longer use the Multitask lowering.
4. The worker board reads outcomes from report previews; runs evicted from the
   8-run live projection fall back to the neutral "Workflow ended" card.
5. Write workers still see observation tools (`TaskOutput`, `TaskStop`,
   `GetWorkflowRun`, `ListWorkflowRuns`, `EvalWorkflowSnippet`) as in M1; none
   can launch orchestration, but `TaskStop` deserves a policy review.
6. Generated workflow names may still be Chinese (M1 gap 3, e.g. the normal
   Workflow regression run was named "m2a 文件清单").
7. Not tested live: mobile web-remote replay of the worker board (same run
   events and projection; only the actor `access` field is new).

## Freeze recommendation

M2 is **ready to freeze for cross-feature integration** as
`feature/multitask-m2`. Integration must reconcile it with the premature
cross-mode commits on `feature/multitask` (`aabd8a8`, `ef14646`) and fix their
`@zcode/shared/cross-mode` bundling break in that pass. Overlap to watch:
`packages/shared/src/zcode-protocol-v4/workflow-runs*.ts` (new optional actor
field), `packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx`,
and `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver*.ts`.
