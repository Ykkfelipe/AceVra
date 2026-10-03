# Cross-Mode × Multitask integration handoff

Written 2026-10-03. First deliberate integration of the frozen Cross-Mode
contract with the frozen Multitask M2 implementation.

| Item | Value |
| --- | --- |
| Branch | `integration/cross-mode-multitask` (pushed to `origin`) |
| Worktree | `/Users/felipemore/Projects/AceVra-integration-cm-mt` |
| Final commit | the commit that adds this file (top of the branch) |
| Status | **Coexistence accepted; handoff seams verified in a real-seam harness** |

## Feature baselines used

| Feature | Ref | Notes |
| --- | --- | --- |
| Shared base | `c02e24c` | merge base of both features (`origin/release/0.1.0-alpha` at freeze time) |
| Multitask | `feature/multitask-m2` @ `e39802a` | frozen M2; integration branch starts here |
| Cross-Mode contract | `feature/cross-mode` @ `b5b4ca1` | frozen M1 contract + M2 preview/admission scaffold |
| Multitask adoption | `feature/multitask` @ `ef14646` | `aabd8a8` (contract snapshot sync) + `ef14646` (adapters); the premature commits documented in the M2 handoff |

History (all `--no-ff`, no rebase, no cherry-pick, upstream branches untouched):

```text
e39802a  M2 frozen head
8aa5a7b  merge feature/cross-mode@b5b4ca1
f12e995  merge feature/multitask@ef14646 (aabd8a8, ef14646)
22c9d55  fix(cli-build): resolve @zcode/shared/cross-mode in the agent bundle
6315cf2  test(integration): Cross-Mode × Multitask handoff scenarios on real seams
<this>   docs: integration handoff
```

Single canonical contract: after both merges `packages/shared/src/cross-mode/**`
is byte-identical to `b5b4ca1` (0-line diff). `aabd8a8`'s synced copy deduped
cleanly. No second copy exists anywhere; the Multitask adapters only import it.
Unrelated sibling branches were not merged. `origin/release/0.1.0-alpha`
(`0da09de`) has drifted 3 commits; a dry-run merge with it is conflict-free.

## Build/export fix (`22c9d55`)

**Symptom.** `@zcode/cli build` and `build:desktop-agent` fail:
`Could not resolve ".../packages/shared/src/index.ts/cross-mode" (originally
"@zcode/shared/cross-mode")`. Reproduced on the integration branch before any
fix.

**Root cause.** `apps/zcode-cli/packages/cli/scripts/build.mjs` keeps a
hand-maintained esbuild alias table that mirrors `packages/shared`'s `exports`.
esbuild rewrites aliases **by prefix**, so every shared subpath needs an exact
entry before the generic `"@zcode/shared"` → `src/index.ts`. Cross-Mode added the
`./cross-mode` export; the Multitask adoption (`core/src/cross-mode`) is the
first CLI-bundled code that imports it. Neither branch fails alone, only the
combination does. The same class of bug is recorded five times in that file's
comments.

**Fix.** One exact alias `@zcode/shared/cross-mode` →
`packages/shared/src/cross-mode/index.ts` (the canonical module). No contract
copy, no unrelated aliases. The four other shared exports without aliases are
not imported by CLI-bundled code and were deliberately left alone.

**Regression guard.** `cli/test/buildAliases.test.mjs` scans the sources of
CLI-bundled packages (skipping packages with their own bundler such as
`node-repl-host`) for `@zcode/shared/<subpath>` imports and requires an exact
alias that resolves to the file declared in shared's `exports`. It failed on
exactly `cross-mode` before the fix and passes after.

**Owner.** CLI build glue (integration). Not Cross-Mode, not Multitask.

Verified in the real dev flow: the agent bundle stages with the contract
included once, and AceVra Dev starts from the integration worktree.

## Contract ownership decisions

| Concern | Owner | Evidence |
| --- | --- | --- |
| Handoff packet, validation, caps, issue codes | Cross-Mode (`@zcode/shared/cross-mode`) | single module, 0-line diff vs `b5b4ca1` |
| Handoff admission records / retries / returns | Cross-Mode admission service | no product code outside shared calls `createHandoffAdmissionService`, preview or store |
| Packet → Multitask input mapping, permission gate, return shaping | Multitask adoption (`core/src/cross-mode`) | imports only contract builders/validation/types |
| Run confirmation, worker graph, lifecycle, cancel/resume, evidence/outcomes | Multitask M2 + Workflow runtime | no M2/Workflow runtime file changed by the integration |
| Executor (`HandoffExecutionPort`) | **unassigned**: Cross-Mode M2 §8 open question | test-only glue in the harness; no production executor |
| Sessions / workspaces | existing host | adapters create no sessions or workspaces; the harness executor runs inside the target session's tool executor |

Import direction: the Cross-Mode contract imports only `zod`, its own files and
`shared/uuid`. Nothing from Multitask, CLI or UI. Multitask depends on the
contract, never the reverse.

## Scenarios

### Live (AceVra Dev from this branch, `~/.zcode-acevra-dev`, GLM-5.3-Flash Low)

| Scenario | Run | Result |
| --- | --- | --- |
| Desktop dev build + agent bundle with Cross-Mode | — | **PASS**: agent bundle staged, contract bundled once, app started |
| Normal Multitask (reader → builder) | `dwfrun-a8dc110a` | **PASS**: "Run this Multitask plan?" gate; worker-first board; builder `1 file changed · 1 command run · 4 tool calls`; `m2c` tests 3/3 re-run independently; 2 reports, 2 worker personas |
| Normal Workflow | `dwfrun-7b2a6265` | **PASS**: "Run this workflow?" gate, timeline UI, header "Workflow completed", 0 reports, no worker persona, plain result without `evidence` |
| Cancellation + resume + completed-worker reuse | `dwfrun-80e9fcbe` | **PASS**: quick settled `ok` (04:16:34) before stop (04:16:51); resumed 04:17:13. Quick's model trace frozen at 3 calls, journal `node-settled ask#1 ok cached:1` with no re-queue, only slow re-queued, one new report, `completed`, UI `Reused` |

### Handoff scenarios: real-seam harness (`bootstrap/test/cross-mode-multitask-integration.test.ts`)

There is no way to start a handoff in the app: neither feature ships a
`HandoffExecutionPort`, the preview UI, or the durable store (all deferred by
Cross-Mode M2), and the adoption adapters have no callers (tree-shaken out of
the bundle). By decision, handoffs are verified through every real seam with
only the model faked: Cross-Mode preview → confirmation → admission service →
adoption adapter → **test-only executor** → real `ToolExecutor` +
`PermissionService` + broker → real Multitask tool → `DynamicWorkflowRunPort`
backed by the real Workflow engine (`runWorkflowScript`, journal, cancel, cold
replay) → real driver evidence stamping → return summary → `recordReturn`.

| Scenario | Result |
| --- | --- |
| Handoff → Multitask | **PASS**: run confirmation shown exactly once with the handoff-derived name; record `accepted` with `{kind: "multitask-run", id}`; M2 outcomes and driver evidence intact (forged evidence overwritten); excluded personal context never reaches worker personas |
| User denies the run confirmation | **PASS**: record `rejected`, no run started |
| Target session unavailable (Multitask not registered) | **PASS**: `rejected` with displayable reason `Multitask did not start: TOOL_NOT_FOUND: Tool not found: Multitask`; Cross-Mode retry works (attempts 2, `accepted`) |
| Under-permitted packet | **PASS**: adapter rejects `multitask_handoff_permission_denied` before submission; no confirmation, no run |
| Cancel → resume after handoff, completed-worker reuse | **PASS**: run `stopped`, handoff record stays `accepted`; resume reuses the completed task (`cached` settle, dispatched once), one report per task, backlink unchanged |
| Return after completion | **PASS**: `completed` return attached once (duplicate rejected); unfinished work returns honestly `partial` with `unresolved`; `returnPolicy: none` returns nothing |

Mutation check: an executor that bypasses the tool executor and submits directly
to the run port fails 5 of 6 scenarios (wrong-flow never reaches submission).

### Boundary verification

- Normal Workflow unchanged: no Workflow file changed; live run identical to M2.
- Multitask keeps M2 worker-first UI and completion semantics: no M2 file changed; live board, outcomes, evidence and reuse re-verified.
- Handoff does not bypass Multitask confirmation/lifecycle: harness routes through the permission gate (denial and mutation tests).
- Multitask does not own Cross-Mode routing/state: adapters use contract builders only; admission records are written only by the Cross-Mode service; run lifecycle never mutates the handoff record.
- No duplicate session/workspace ownership: no session or workspace is created by either feature's integration code.

## Validation

- Tests: **82 passed**: shared Cross-Mode 39; CLI 35 (Multitask M2 core 11, runtime 7, evidence 2, adoption conformance 9, integration harness 6); UI 6; build guard 2. CLI suites run with `mise exec -- node --import tsx --test …`; shared/UI with `TSX_TSCONFIG_PATH=<pkg>/tsconfig.json`.
- `pnpm typecheck`: passed. `@zcode/{core,bootstrap,contracts,dynamic-workflow,cli}` typecheck: passed.
- `pnpm lint`: 0 errors, 86 warnings (baseline). Touched files: 0 warnings, 0 errors.
- `pnpm architecture:check --changed`: 0 violations.
- `pnpm fmt:check`: fails on 43 files. **35 are pre-existing at `c02e24c`**, none come from the integration, and 8 come from the features themselves (3 roadmap docs, 4 M2 UI files and the M2 handoff doc). Not reformatted here to keep the frozen features byte-identical; see upstream fixes.
- No packaging, DMG/ZIP, `/Applications/AceVra.app`, Personal Bot or Auth changes.

## Integration bugs and fixes

1. **`@zcode/shared/cross-mode` unresolved in the CLI bundle.** Fixed in `22c9d55` (integration glue), with regression guard. See above.
2. **Environment, not product:** the first dev start failed on ad-hoc codesign
   ("bundle format is ambiguous") because this worktree's
   `node_modules/electron/dist` had been extracted with its framework symlinks
   flattened. Repaired locally by re-running Electron's `install.js`; no source
   change. Worth knowing for any fresh worktree.

## Upstream fixes required

| Fix | Belongs to | Detail |
| --- | --- | --- |
| Evidence scope across resume | **Multitask (M2 follow-up)** | Live `dwfrun-80e9fcbe`: a worker cancelled mid-task resumes in its rehydrated session (21 messages, 11 prior file reads) and only calls `submit_result`, so per-attempt evidence is 0 and it lands `Unverified: no tool use was observed`. Conservative (never a false success) but misleading. Proposed: carry the cancelled attempt's tool counts into the re-dispatched ask (driver-owned, from journaled stats), or word the state as "no new tool use in the resumed attempt". Not handoff-specific. |
| `HandoffExecutionPort` production implementation | **Cross-Mode executor milestone** (host decision per §8) | The harness glue is the reference shape: adapter → target session's tool executor (keeps the run confirmation) → `accepted(multitask-run)` / `rejected(code: message)`. Also needs the run-outcome → return-status mapping (all `done` → `completed`, else `partial`, run stopped → `cancelled`), which neither feature owns today. |
| Durable admission store | Cross-Mode | In-memory reference store only; records do not survive restarts. |
| Format drift | Cross-Mode docs, Multitask adoption doc, Multitask M2 UI files | `oxfmt` on the 8 feature-introduced files. |

## Remaining integration risks

1. **No production handoff path yet.** Live handoff, mobile/remote delivery of
   handoff state and crash recovery of `dispatched` records are unverified until
   the executor, preview UI and durable store exist.
2. The run-outcome → return-status mapping lives only in test glue; whoever
   builds the executor must own it (it is integration logic, not contract).
3. The shared root barrel now re-exports `cross-mode`, so renderer bundles that
   import `@zcode/shared` include the contract module (zod schemas only, no IO).
4. The alias table is still hand-maintained; the guard prevents silent breakage
   for imported subpaths but does not auto-derive aliases.
5. Release drift: `origin/release/0.1.0-alpha` gained 3 unrelated commits
   (saved CUA workflows, formatting); dry-run merge is clean.

## Merge recommendation

**Safe to merge into the shared release baseline as a coexistence integration.**
The build break is fixed with a guard. Both features' suites and live behavior
are unchanged, the contract has one canonical surface, and ownership is clean.
The handoff seams compose correctly through the real confirmation and lifecycle
paths. Not yet a user-visible handoff feature: that requires the Cross-Mode
executor milestone, plus the Multitask evidence-across-resume follow-up for
cleaner resumed outcomes.
