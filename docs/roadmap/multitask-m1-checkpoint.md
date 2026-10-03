# Multitask M1 implementation checkpoint

Branch: `feature/multitask`, worktree: `/Users/felipemore/Projects/AceVra-multitask`.
Baseline: clean worktree fast-forwarded to `origin/release/0.1.0-alpha` at
`c02e24c2` before implementation. The two reference roadmaps were read with
`git show origin/roadmap/multitask-future:docs/roadmap/...`; the documentation
branch was not merged.

## Implemented

Ask AceVra to “use Multitask” or “use parallel workers” for an objective. The
coordinator submits a structured graph through the new `Multitask` tool, with
1–4 workers and at most 16 tasks. The normal Workflow run confirmation shows
the generated execution graph, then launches a background run. Its existing
colored worker roster and child conversation inspector remain available.
Multitask rows and confirmation use their own product name. Workflow remains
available as the explicit repeatable script interface.

Dependencies are validated, passed into downstream task prompts, and enforced
at execution. Safe readers can overlap. Every writer executes exclusively in
the shared checkout. Read workers exclude shell, REPL and MCP tools through a
real allowlist. Children cannot launch Multitask or nested orchestration.

Worker roles, normal/saved profile names, model selections including reasoning,
tool lists/denies, permission mode and max turns are frozen into journalled
actor personas. Explicit worker models override profile defaults; ordinary
Workflow run model overrides still apply when configuring an existing run.
The coordinator synthesizes results by task ID from the existing completion
notification; there is no separate synthesis worker or recursive hierarchy.

## Architecture reused

`CreateWorkflow` analysis, approval, submission and display; DynamicWorkflowRunPort;
Workflow scheduler, concurrency governor and dependency execution; persistent
journal, background runtime task registry, cancellation and cold replay;
AgentRuntime child sessions; desktop continuous and mobile replayable run events;
existing Workflow card, roster, current-task/activity display and inspection panes.
There is no second executor, queue, state owner, database or wire-payload migration.
Computer Use and packaging code are unchanged.

## Changed files

- Spec: `apps/zcode-cli/packages/core/specs/multitask.md`.
- Tool contract/export: `apps/zcode-cli/packages/contracts/src/tools/{multitask,index}.ts`.
- Graph submission/registration: `apps/zcode-cli/packages/core/src/tool/handlers/{multitask,multitask-graph,index,agent}.ts`.
- Run display/lifecycle: `apps/zcode-cli/packages/core/src/tool/executor/{create-workflow-display,background-task-registry}.ts`.
- Child guards: `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts`, `apps/zcode-cli/packages/core/src/subagent/tool-policy.ts`, `apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-tools.ts`.
- Frozen persona contract: `apps/zcode-cli/packages/dynamic-workflow/src/engine/{types,worker-policy}.ts`, `apps/zcode-cli/packages/dynamic-workflow/src/facade/dts.ts`.
- Child factory: `apps/zcode-cli/packages/bootstrap/src/app/{create-app,multitask-actor-policy}.ts`.
- UI identity/join: `packages/shared/src/tool-identity.ts`, `packages/ui/src/lib/workflowToolNames.ts`, `packages/ui/src/v4/{ConversationRowView,WorkflowToolSummary}.tsx`.
- Card/approval/localization: `packages/ui/src/ToolCallBlocks/renderers/create-workflow.tsx`, `packages/ui/src/WorkflowPermissionBlock.tsx`, `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`.
- Tests: `apps/zcode-cli/packages/core/test/multitask.test.ts`, `apps/zcode-cli/packages/bootstrap/test/multitask-runtime.test.ts`, `packages/ui/test/multitask.test.tsx`.
- This checkpoint report.

## Validation

- Workspace freshness: passed after baseline merge.
- `pnpm typecheck`: passed. Initial missing account API dependencies were resolved
  with `pnpm install --frozen-lockfile`; no lockfile changes.
- `pnpm lint`: passed, 86 existing warnings, zero errors.
- `pnpm architecture:check --changed`: passed, zero baseline/new violations.
- `pnpm --dir apps/zcode-cli --filter @zcode/bootstrap... build`: passed; only
  CLI dependency outputs, no desktop packaging.
- `mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/multitask.test.ts apps/zcode-cli/packages/bootstrap/test/multitask-runtime.test.ts`: 11 passed.
- `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/multitask.test.tsx`: 1 passed.
- The full tool executor test covers raw graph admission, generated-script
  confirmation and one background submission. The real Workflow harness tests
  cover reader overlap, writer exclusion, dependency results, persona persistence,
  cancellation and cold replay with completed-result reuse.
- UI rendering/identity tests cover the Multitask label and existing run-detail
  link. The spec records the live end-to-end acceptance scenario.
- `git diff --check`: passed.

No desktop live runtime was started. No existing feature dev runtime was detected
in the process ownership check. Visual/live acceptance is pending: approve a
Multitask request, inspect its colored workers and live child conversations,
cancel/resume via the existing controls, and check the coordinator's final
synthesis. Real provider execution and desktop/mobile delivery were not exercised
live. No DMG, ZIP or packaged AceVra app was created; `/Applications/AceVra.app`
was untouched. Tests remove their temporary harness/draft directories. Local
ignored dependency outputs and small `/tmp/acevra-multitask-*.log` check logs remain.

## Known gaps / next milestone

M1 uses the existing detailed Workflow run view. M2 should introduce the compact
worker-first Multitask view, retaining the graph as an advanced view, and complete
live desktop/mobile acceptance and a real-provider benchmark. Full Subagent
profile parity is pending: skill preload, scoped MCP and memory profiles are
explicitly rejected; instruction-injection options and profile colors are not
mapped, and existing Workflow context/color rules apply. Token/time/stage budgets
and run-level mutable shared discoveries are also follow-ups; M1 provides bounded
workers/tasks and static shared context. Parallel writers remain disabled until
real Git worktree isolation and deliberate integration exist.

No environment secrets, runtime configuration files, database migrations or
other feature branches are required or modified. Integration may overlap other
workers editing tool registration, shared tool identity, UI run summaries or
`bootstrap/src/app/create-app.ts`; reconcile those edits deliberately.
