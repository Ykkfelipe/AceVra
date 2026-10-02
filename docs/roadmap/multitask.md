# AceVra Multitask — Future Roadmap

> Status: **future feature / roadmap only**. Do not implement as part of current work.
>
> This document preserves the agreed direction for AceVra's future Multitask feature without changing or interrupting work already in progress.

## Product direction

Keep the existing **Workflow engine/runtime primitives**, but do **not** use the current Workflow experience as the final Multitask UX.

- **Workflow** stays the explicit/repeatable orchestration feature: scripts, saved workflows, phases, arguments, artifacts, dashboards, deterministic runs.
- **Multitask** becomes the dynamic one-off mode for: “split this larger objective among several workers and get it done.”
- Multitask remains **explicitly opt-in**. It should not activate automatically unless the user asks for Multitask / parallel workers.

## Reuse instead of rebuild

Reuse as much existing infrastructure as possible:

- workflow scheduler / concurrency machinery
- background run execution
- child AgentRuntime sessions
- journal / history
- cancellation
- resume / amend semantics
- completed-result reuse
- provider error handling
- runtime events / progress tracking
- dependency execution
- run inspection

Treat Workflow as infrastructure underneath Multitask rather than rebuilding another orchestration engine from scratch.

## Core Multitask changes

### 1. Per-worker profiles and models

Connect workers to AceVra's existing Subagent profile system.

A worker should be able to have its own:

- model selection
- system prompt / role
- tools / disallowed tools
- skills
- permission mode
- max turns
- MCP / plugin capability where supported

Example:

- Explorer → DeepSeek V4.1 Flash
- Builder → stronger coding model
- Verifier → GLM-5.3 Flash
- Reviewer → stronger reasoning model only when justified

Avoid the current Workflow limitation where the whole run uses one child-agent model.

### 2. Direct task-graph execution

For Multitask, do not require the coordinator to author a full `.dwf.ts` Workflow script first.

Prefer a lightweight structured task graph:

```json
{
  "tasks": [
    { "id": "inspect-runtime", "worker": "explorer", "dependsOn": [] },
    { "id": "inspect-ui", "worker": "explorer", "dependsOn": [] },
    { "id": "implement", "worker": "builder", "dependsOn": ["inspect-runtime", "inspect-ui"] },
    { "id": "verify", "worker": "verifier", "dependsOn": ["implement"] }
  ]
}
```

The underlying Workflow scheduler/runtime can still execute the dependencies.

### 3. Lean execution policy

Multitask should use the **minimum useful parallelism**, not automatically build a long research/review/report pipeline.

Suggested behavior:

- simple task → 1 worker
- unknown bug → explorer + builder
- medium feature → explorer + builder + verifier
- large independent task → 2–4 parallel workers
- high-risk change → add independent review when justified

Do **not** automatically create synthesis, reviewer, correction, report-writer, and report-fixer workers for ordinary tasks.

The coordinator should usually synthesize the final answer itself.

Add internal execution budgets such as:

- max workers
- total token budget
- time budget
- max sequential stages
- max review passes

Potential user-facing presets later: **Fast / Balanced / Thorough**.

### 4. Scoped/shared context

Workers should receive only the context relevant to their assignment instead of repeatedly absorbing large overlapping project context.

Add a run-level shared knowledge surface for discoveries and decisions so sibling workers do not repeatedly rediscover the same facts.

### 5. Worktree isolation before parallel writers

Read-only workers may share the same checkout.

Before allowing multiple code-writing workers at the same time, implement real Git worktree/workspace isolation.

- one editing worker → shared checkout can be acceptable
- multiple editing workers → isolated worktrees
- integration step reconciles completed changes

Do not rely only on prompts to prevent agents from colliding.

### 6. Keep worker hierarchy shallow initially

Do not enable arbitrary nested agent spawning in the first Multitask version.

Initial structure:

```text
Coordinator
  ├─ Worker
  ├─ Worker
  └─ Worker
```

This avoids uncontrolled worker/token explosion. Recursive delegation can be considered later with strict budgets.

## UI / UX direction

**Keep the current colored bot circle/bubble feeling.** That visual identity should be preserved and polished.

Default Multitask view should make each worker immediately understandable:

- colored bot bubble
- worker name / role
- selected model
- working / waiting / completed / failed state
- current task / current action
- elapsed time
- optional token usage
- files touched
- expandable recent activity
- “Open agent” / inspect conversation

Keep dependencies visually simple:

```text
[Explorer] ──┐
             ├──> [Builder] ───> [Verifier]
[UI Agent] ──┘
```

The current detailed Workflow DAG/thread visualization can remain available as an **advanced “Execution graph” view**, but should not be the primary Multitask UI.

Avoid duplicated information between the main card and side pane.

## Baseline benchmark from current Workflow

The read-only Workflow/Subagent architecture investigation is the baseline for improvement:

- **27m 06s**
- **5.15M cumulative tokens**
- **9 subagents**
- **5 phases**
- four initial investigators in parallel, followed by synthesis/review/correction/report stages

This run proved the runtime is capable, but also showed why the current Workflow experience is too heavyweight for everyday Multitask use.

When the first Multitask prototype exists, rerun essentially the same architecture investigation and compare:

- wall-clock time
- cumulative tokens
- number of workers
- number of sequential barriers
- answer quality / verification quality
- usability of the worker UI

Goal: dramatically lower overhead while preserving the useful scheduler/journal/recovery machinery.

## Suggested implementation order

- [ ] Per-worker Subagent profile + model support
- [ ] Direct structured task-graph submission for Multitask
- [ ] Lean execution / budget policy
- [ ] Scoped + shared run context
- [ ] Real worktree isolation for concurrent writers
- [ ] Polished bot-bubble Multitask UI
- [ ] Keep detailed dependency graph as advanced view
- [ ] Benchmark against the 27m / 5.15M-token Workflow baseline
- [ ] Only later consider nested delegation and cross-device scheduling

## Non-goals for now

- Do not rewrite the entire Workflow engine.
- Do not remove the existing Workflow feature.
- Do not make Multitask activate automatically without explicit user intent.
- Do not redesign current in-progress work around this roadmap yet.

## Parallel development / build policy

When implementation begins:

- create a fresh `feature/...` branch from the latest good `main`
- give the implementing worker its own Git worktree
- do not point multiple code-writing workers at the same checkout
- prefer targeted tests/checks during development
- do not create persistent packaged desktop builds from feature worktrees
- let the integration/main workspace own the single canonical packaged AceVra build
- clean temporary feature build outputs after validation
- remove the worktree after the feature is merged

Full details: `docs/roadmap/parallel-development-policy.md`.

The roadmap branch itself is documentation/reference only; do not use it as a long-lived implementation base.