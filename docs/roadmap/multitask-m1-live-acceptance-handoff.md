# Multitask M1 live-acceptance handoff

Handoff for the next agent (Claude). Written 2026-10-03 during the live
acceptance pass that followed the M1 implementation checkpoint
(`docs/roadmap/multitask-m1-checkpoint.md`).

## Where we are right now

| Item | Value |
| --- | --- |
| Worktree | `/Users/felipemore/Projects/AceVra-multitask` |
| Branch | `feature/multitask` |
| Branch head | `59ca23d` + this handoff commit (see commit list below) |
| Baseline | `c02e24c` (`origin/release/0.1.0-alpha`) |
| Product source state | 3 live-reproduced bugs found and fixed, all committed and pushed |
| M1 status | **Accepted — all five live scenarios passed, including write workers** |

The M1 implementation itself (commit `6df2d58`) is unchanged in intent. This
pass added three targeted fixes and produced the live evidence below.

### Commits added during this acceptance pass

| Commit | Subject |
| --- | --- |
| `a2141c1` | `fix(multitask): stop forcing unimplemented auto permission mode on workers` |
| `0372ae8` | `fix(context): make the response-language rule binding over instruction files` |
| `59ca23d` | `fix(multitask): stop passing the "*" tool wildcard into the runtime allowlist` |

All three are pushed to `origin/feature/multitask`.

## Live acceptance results

AceVra Dev (this worktree) was driven over CDP on port `9229` with a real Z.ai
provider account (`GLM-5.3-Flash`, reasoning Low). The desktop dev slot was not
owned by another feature worker when this pass started; the runtime was
restarted between fixes so each one was exercised live.

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Simple task → coordinator plans 1 read worker | **PASS** |
| 2 | Medium task → explorer + builder | **PASS** (writer verified doing the edit itself) |
| 3 | explorer + builder + verifier | **PASS** |
| 4 | Cancellation during an active run | **PASS** |
| 5 | Resume of a stopped run | **PASS** |
| 6 | Reader concurrency | **PASS** — run details reported `Concurrency 2` with `2 agents working` |
| 7 | Normal Workflow regression | **PASS** — single-step Workflow completed `1/1` |

Details:

- **Scenario 1** — plan preview showed `1 phase · At most 1 subagents at once`.
  The worker read `inventory.json` and returned apple 3 / pear 5 / orange 2 /
  total 10; the coordinator synthesized it. Worker transcript opens from the
  colored pill and shows a real `Read` call.
- **Scenario 2** — `1 phase · 2 agents`, `Workflow 2/2`. After the writer fix,
  the model-IO trace for the write worker shows a **19-tool set**
  (`Bash, Edit, Read, …, Write, escalate, …`) and four model calls:
  `Read ×3` → **`Edit`** → `Bash` (tests) → final text. The writer performed the
  edit and ran `node --test` itself. `cart.mjs` correct, 3 tests pass.
- **Scenario 3** — `1 phase · 3 agents`, `Workflow 3/3`. The verifier is a real
  independent reader: it re-read the files and reported
  `**Verification result: FAIL — discountTotal was never implemented.**` while
  the writer was still broken. After the writer fix the same shape is expected
  to pass without coordinator help (scenario 2 re-run proves the writer path).
- **Scenario 4** — `Stop run` mid-flight produced `Workflow stopped · by you`
  and a `Resume run` affordance; the coordinator reported honestly that neither
  worker finished rather than inventing findings.
- **Scenario 5** — clicking `Resume run` restarted the stopped run
  (`1 phase · 2 agents working`), it progressed and completed `2/2`. Note this
  run had no completed worker output to reuse, so replay-reuse of finished
  readers is still only covered by the runtime test.
- **Scenario 6** — two independent read workers showed `2 agents working` and
  the run-details pane reported `Concurrency 2`.
- **Scenario 7** — normal `Workflow` (not Multitask) still generates a script,
  gates on the same confirmation dialog and completes `1/1` with one agent.

UI behaviour confirmed live: colored per-worker pills (`wf-pill wf-agent-pill`,
one per worker, role-prefixed names), per-worker transcript panes opened from
`Open the transcript of …` pills, run-details pane with `Concurrency`, step
fractions and token counts, and the existing Workflow permission gate for the
generated plan.

## Bugs found and fixed (all reproduced live, not theorised)

**1. Workers denied every tool (`a2141c1`)**

The first live run completed `1/1` but the worker returned nothing. Its
transcript showed `Read` and `Grep` denied with *"Auto mode is reserved but not
implemented yet"*. Both Multitask lowering sites defaulted a missing profile
`permissionMode` to `"auto"`, and `PermissionService` rejects `auto`
unconditionally (`permission/service.ts:140` → rule `mode.auto.unimplemented`).
The normal subagent path leaves the value undefined so
`resolveSubagentPermissionMode` inherits the parent mode
(`runtime/methods/subagent.ts:473`). Fixed by only forwarding `permissionMode`
when the profile declares one.

**2. Coordinator answers in Chinese (`0372ae8`)**

An English request was answered entirely in Chinese. The UI locale is `en-US`
(settings dump in the dev log), so this was the model mirroring the workspace
`AGENTS.md`, which is Chinese and is injected as `meta_user`
(`context/builder.ts:125` documents exactly this hazard). The response-language
policy existed but the model still drifted. Fixed by making the rule binding:
instruction files and repository docs "must never change, override or dilute
the language of your reply", with an explicit English-request/Chinese-workspace
example. Verified live afterwards: all coordinator output was English.

Residual, non-blocking: the model still names *generated* artifacts in Chinese
(a workflow titled `列出 fixture 文件` with an agent named `文件清点员`). The rule
governs reply language, not model-invented script identifiers. If that matters
product-side, it is a separate, small prompt change.

**3. Write workers had no tools at all (`59ca23d`) — the important one**

Every write worker produced one line of text and stopped. Proof from the
model-IO traces under
`~/.zcode-acevra-dev/.zcode/cli/debug/model-io-sess_dwf-<run>-actor_2_1.jsonl`:

```
toolNames: []            ← writer: EMPTY tool set
text: "Reading the files first."
finishReason: "stop", toolCalls: []
```

versus the read worker in the same run:

```
toolNames: ["Glob","Grep","Read","WebFetch","WebSearch"]
```

Cause: the generated persona carried the profile's `"*"` wildcard verbatim
(`"worker": {…, "tools": ["*"] }`) and `multitaskActorPolicy` forwarded it as
`toolAllowlist`. The tool registry intersects an allowlist by **exact tool
name** (`tool/handlers/index.ts:234-246`), so the literal `"*"` matched nothing
and the whole built-in tool surface was filtered away. Workflow actors are
subtraction-only by design (`workflow-actor-tools.ts`), so narrowing was never
meant to apply here. Fixed by treating `"*"` and a missing list as "no
narrowing" in both the script lowering (`multitask-graph.ts`) and the actor
policy, while keeping concrete profile lists and the M1 read-worker read-only
allowlist.

Guardrails verified on the fixed writer: its 19 tools contain **none** of
`Agent`, `Task`, `Workflow`, `Multitask`, `CreateWorkflow`, `AmendWorkflow`,
`ResumeWorkflowRun`, `SaveWorkflow`, `AskUserQuestion`, `EnterPlanMode`.

Two further consequences worth knowing:

- The Workflow runtime reports these runs as **settled, not succeeded**. While
  the writer bug was live, a writer that did nothing still produced
  `Workflow 2/2`, so a green card is not proof the work happened.
- Multitask was only "working" before `59ca23d` because the coordinator
  verified. In both failing runs the coordinator read the run record, ran the
  tests itself, noticed the stub and finished the edit. A coordinator that
  trusted worker output would have shipped a no-op. This is why the writer
  scenario was re-run after the fix rather than accepted on the green card.

## Reproducing the live environment

The dev runtime needs the Workflow rollout gate locally overridden, because the
production account has it off and both Workflow and Multitask are otherwise
absent from the session:

```bash
cd /Users/felipemore/Projects/AceVra-multitask
ZCODE_DYNAMIC_WORKFLOW_MODE=alwaysOn mise run dev      # dev-only override
```

`ZCODE_DYNAMIC_WORKFLOW_MODE` is defined in
`packages/shared/src/dynamic-workflow-feature.ts`; `alwaysOn` is a legitimate
dev value. Packaged builds rewrite or drop the shell value, so this cannot leak.

The renderer exposes CDP on `127.0.0.1:9229`. Two helper scripts were written
for this pass and are worth reusing:

- `.spike/multitask-m1-live/cdp.mjs` — minimal Playwright-over-CDP driver with
  `text`, `send`, `click`, `clickrole`, `shot`, `wait` subcommands. The composer
  is a `div[contenteditable="true"][role="textbox"]`, **not** a textarea, so a
  placeholder-based `fill` fails; use the helper.
- `.spike/multitask-m1-live/ts-resolve.mjs` — Node module hook that maps the
  repo's `.js` import specifiers onto `.ts` sources. Repo TS tests cannot run
  under plain `node --test` (pre-existing, reproducible on a clean tree); run
  them with:

```bash
mise exec -- node --experimental-transform-types \
  --import ./.spike/multitask-m1-live/ts-resolve.mjs \
  --test apps/zcode-cli/packages/core/test/multitask.test.ts \
         apps/zcode-cli/packages/bootstrap/test/multitask-runtime.test.ts
```

Model-level forensics come from
`~/.zcode-acevra-dev/.zcode/cli/debug/model-io-sess_<session>.jsonl` — one JSON
record per model call with `request.toolNames`, `response.toolCalls` and
`finishReason`. This is the fastest way to prove what a worker could and did do.

The acceptance fixture lives in `.spike/multitask-m1-live/fixture/`
(`contract.md`, `cart.mjs`, `cart.test.mjs`, `inventory.json`). It is
intentionally **not** committed as product code.

## Validation run in this pass

- Multitask suites: **14 passed** (`core/test/multitask.test.ts`,
  `bootstrap/test/multitask-runtime.test.ts`).
- Response-language suite: **6 passed**.
- `pnpm typecheck` (root): passed.
- `pnpm --filter @zcode/core --filter @zcode/bootstrap typecheck`: passed.
- `pnpm architecture:check -- --changed`: passed, 0 violations, 0 new.
- `pnpm --filter @zcode/core lint`: 0 errors, 11 pre-existing warnings.
- `pnpm --filter @zcode/bootstrap lint`: **fails on a clean tree too**
  (`oxlint src` finds no files). Pre-existing, unrelated.

Not run, deliberately: no packaging, no DMG/ZIP, `/Applications/AceVra.app`
untouched, Computer Use untouched, no M2 work started.

## Remaining known gaps

1. **Replay reuse on resume** — the resumed run had no completed reader output
   to reuse, so "completed readers are not recomputed" is only covered by the
   runtime test, not observed live.
2. **Worker premature turn completion** — the `"*"` allowlist bug fully
   explains the observed writer failures, and the fixed writer completed
   normally. Whether a tooled worker can still end a turn without acting
   (model-side, more likely at Low reasoning) is unproven. If it recurs the run
   still reports success, so coordinator verification remains load-bearing.
3. **Generated artifact language** — model-invented workflow/agent names still
   come out in Chinese; see bug 2's residual note.
4. M2 scope items from the checkpoint doc are untouched: compact worker-first
   view, full Subagent profile parity (skills/MCP/memory profiles are explicitly
   rejected), token/time budgets, mutable shared discoveries, parallel writers.

## Recommended next milestone

M1 is accepted. Proceed to M2 (compact worker-first Multitask view, retaining
the graph as an advanced view) as described in
`docs/roadmap/multitask-m1-checkpoint.md`. If a quick hardening pass is wanted
first, the highest-value item is making a worker turn that produces no tool call
and no result surface as a warning instead of a silent success.
