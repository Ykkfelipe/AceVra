# Cross-Mode executor handoff — production `HandoffExecutionPort` (Coding → Multitask)

Written 2026-10-03. Follow-up to `cross-mode-multitask-integration-handoff.md`:
the handoff harness's test-only glue is replaced by production code; a real
handoff can be initiated through the app path and reach Multitask through the
normal run-confirmation gate. Frozen refs untouched (Cross-Mode contract
`b5b4ca1`, Multitask M2 `024183c`).

| Item | Value |
| --- | --- |
| Branch | `integration/cross-mode-multitask` (pushed to `origin`) |
| Worktree | `/Users/felipemore/Projects/AceVra-integration-cm-mt` |
| Baselined on | `ccfbe09` (Multitask M2 `024183c` baseline update) |
| Final commit | the commit that adds this file (top of the branch) |
| Status | **Production executor + V4 command entry landed; live acceptance passed (allow + deny)** |

## Ownership map

| Concern | Owner | Where |
| --- | --- | --- |
| Handoff records / retries / returns (admission) | Cross-Mode (frozen M2 scaffold) | `createHandoffAdmissionService` — `packages/shared/src/cross-mode/admission.ts` |
| packet → Multitask submission + return shaping | Multitask adoption adapter (`ef14646`) | `buildMultitaskHandoffSubmission` / `buildMultitaskHandoffReturn` — `apps/zcode-cli/packages/core/src/cross-mode/` |
| Run confirmation / run lifecycle / cancel / resume / evidence | Workflow M2 (real runtime + dwf engine) | `AgentRuntime.scheduleTools`/`executeTools`, `subscribeRunSettled` / `getRunDetail` |
| Coordination port (`HandoffExecutionPort`) | Bootstrap app layer (this milestone) | `apps/zcode-cli/packages/bootstrap/src/app/cross-mode-handoff-executor.ts` |
| Initiation (real caller) | V4 command `startMultitaskHandoff` (this milestone) | `packages/shared/src/zcode-protocol-v4/multitask-handoff-command.ts` + `bootstrap/.../handlers/cross-mode-handoff.ts` |
| Run-outcome → return-status mapping (canonical) | Cross-Mode handoff service (this milestone) | `buildMultitaskHandoffReturnFromRun` — `bootstrap/src/app/cross-mode-handoff-service.ts` |

The executor duplicates no state: it resolves the per-handoff binding (plan +
trace), maps through the adoption adapter, submits via the session runtime's
**own** tool path (schedule → run confirmation → execute), and returns only
`accepted(externalRef)` or `rejected(bounded reason)`. The binding is released
only on accept (a rejected submission stays retryable with the same binding).

## Initiation path (production)

`v4/command` `startMultitaskHandoff` → handler → `ZCodeApp.startMultitaskHandoff`
→ `cross-mode-handoff-service.start()`:

1. session-busy guard (`getActiveTurnInfo`), then
2. frozen packet build + preview confirmation + admission — the frozen contract
   validates the boundary (coding → multitask requires `linkedProject`), then
3. execution: adapter permission floor (reader ⇒ `repo-read`; writer ⇒
   `repo-read` + `repo-write`) → a real `Multitask` tool call via
   `scheduleTools`/`executeTools` → **normal run confirmation gate** (permission
   broker) → run registered → `backgroundTaskId`, then
4. ACK: `{type, handoffId, status:"accepted", externalRef:{kind:"multitask-run", id}}`
   — or `status:"rejected"` with a bounded displayable reason.

The command **waits for the gate decision** before ACK — a denied confirmation
returns `status:"rejected"`, `externalRef:null`, and no run exists (verified
live). Session busy is rejected up front (`session_busy` fault) and re-checked
at submit time (rejected record, retryable). Fault namespace:
`fault.command.multitaskHandoffStartRejected.{invalid_input|session_busy|start_failed}`;
`invalid_input` carries the frozen-contract validation summary in `message`.

## Return path (auto-return policy)

On run settlement (`subscribeRunSettled`): only `status === "completed"` maps;
`stopped` is a **resumable intermediate state and is never preempted**.
`getRunDetail(runId).result` (per-task report artifact) →
`buildMultitaskHandoffReturnFromRun` (canonical mapping owner) → `recordReturn`.

| Run state | Return status |
| --- | --- |
| completed, all tasks `done` | `completed` |
| completed, unfinished tasks | `partial` (never upgraded; unfinished listed in `unresolved`) |
| stopped | `cancelled` |
| failed / errored | `failed` |
| `returnPolicy:"none"` | no return |

## Link-case coverage

| Case | Evidence |
| --- | --- |
| accepted | harness scenario + **live** |
| user denied | harness scenario + **live** (no run created) |
| unavailable target | harness scenario |
| permission denial (adapter floor) | unit + harness (“wrong-flow or under-permitted packets are rejected, never submitted”) |
| cancel / resume | harness (M2 resume semantics; completed worker reused) |
| completed return | harness + unit mapping |
| partial return | unit mapping + **live partial** (isolated home: worker without model → report `failed`/`skipped` → partial) |
| no-return policy | unit + harness |

## Live acceptance (real app path, no test-only glue)

Driver (committed): `apps/zcode-cli/scripts/cross-mode-handoff-live-acceptance.mjs`.
It boots the built `zcode.cjs app-server --stdio` as a real protocol client
(NDJSON), isolates `HOME`/`ZCODE_DATA_BASE_DIR` into a temp dir, creates a draft
session with the dynamic-workflow gate on, sends the real `startMultitaskHandoff`
command, and answers the permission gate as the user would.

| Scenario | Command | Result |
| --- | --- | --- |
| allow | `node apps/zcode-cli/scripts/cross-mode-handoff-live-acceptance.mjs` | **PASS** — gate request `Multitask` (“always requires explicit approval”) approved by the driver; ACK accepted + `externalRef {multitask-run: dwfrun-3b117991…}` (session `sess_a0d0bf69…`, handoff `6c4f1393…`); run catalog query: run completed, `toolCallId: handoff-6c4f1393…`; per-task report `inspect failed / report skipped` → auto-return mapped **partial** |
| deny | `… --deny` | **PASS** — gate denied (handoff `737d35c7…`); ACK `status:"rejected"`, `externalRef:null`, reason `Multitask did not start: PERMISSION_DENIED: …`; run catalog **empty** |

Reproduce: `pnpm --dir apps/zcode-cli cli:build` first (the script uses the
bundle); `--print-frames` adds wire-level tracing; `--clean-data` removes the
temp home on success.

Notes:
- worker model execution needs a configured home. The fresh isolated home has no
  model selection, so workers fail fast (`Failed to create the subagent session:
  … no model selection` DriverError) while the initiation → reach → settle chain
  still completes end-to-end. The M2 baseline update separately proved real
  worker execution (dev home, GLM-5.3-Flash).
- the app-server store derives from `HOME` (`~/.zcode/cli/db/db.sqlite`); the
  script always overrides `HOME` + `ZCODE_DATA_BASE_DIR`. No user data is touched.
- draft-session caveat: a handoff on a never-persisted draft session cannot
  ledger its completion notification (`FOREIGN KEY constraint failed` warnings);
  harmless for acceptance, not expected in real flows (an initiated handoff
  normally follows user conversation).

## What remains (out of scope here)

| Item | Owner |
| --- | --- |
| Desktop UI entry (bind the command to a user surface) + return display | Desktop / Cross-Mode UI |
| Retry affordance for rejected records (service `retry()` exists) | Cross-Mode UI |
| Durable admission store (records survive restart) | Cross-Mode (M2 scope) |
| Evidence-across-resume wording | Multitask M2 follow-up (see integration handoff doc) |

Personal Bot integration: the port + command surface is feature-neutral; a
future Coding → Bot executor plugs in beside this one.

## Verification (this milestone)

- `bootstrap` cross-mode tests **12/12** (6 unit + 6 harness scenarios; the
  harness now drives the production executor + service instead of test glue)
- shared cross-mode **39/39**; core multitask + bootstrap runtime **20/20**
- turbo typecheck `@zcode/core`, `@zcode/bootstrap`, `@zcode/cli` **13/13**;
  `tsc -b packages/shared` clean
- architecture **0 violations**; `oxfmt` / `oxlint` clean on touched files
- CLI bundle built; live acceptance above

## Files

| Area | Files |
| --- | --- |
| Shared | `zcode-protocol-v4/multitask-handoff-command.ts` (new), `command.ts`, `index.ts` |
| Core | `src/index.ts`, `src/runtime.ts` (exports `ExecuteToolsOptions` / `ExecuteToolsResult`) |
| Bootstrap | `app/cross-mode-handoff-executor.ts` (new), `app/cross-mode-handoff-service.ts` (new), `app/create-app.ts`, `app/types.ts`, `zcode-protocol-v4/commands/handlers/cross-mode-handoff.ts` (new), `handlers/index.ts` |
| Tests | `bootstrap/test/cross-mode-handoff.test.ts` (new), `bootstrap/test/cross-mode-multitask-integration.test.ts` (rewritten to drive production) |
| Scripts | `apps/zcode-cli/scripts/cross-mode-handoff-live-acceptance.mjs` (new) |
