---
name: cua-system-map
description: "Use when diagnosing or planning work on the Computer Workspace (CUA) stack in this repo: the full provenance chain from model cell to Helper, symptom-to-boundary tables, single-owner map of bar/panel/projection/labels, and the test entry points per layer. Read-only map; verify against current HEAD before acting."
---

# Computer Workspace system map (diagnose before you change)

Scope snapshot: `release/0.1.0-alpha` @ `9cd6581`. If HEAD moved, re-verify file paths with a
quick grep before trusting this map. Accepted, do-not-reopen product behaviors are listed at
the end — do not "fix" them.

## 1. Execution provenance (model cell → Helper)

```
model turn (desktop task, session)
  → node_repl "js" tool  [TWO legal surfaces]
      a. MCP host: separate process, title "zcode-node-repl-mcp"
         apps/zcode-cli/packages/node-repl-host/src/server.ts
      b. core built-in handler (CLI/agent process)
         apps/zcode-cli/packages/core/src/tool/handlers/node-repl.ts
  → injectedGlobals() per cell:
      - bridge symbol ALWAYS installed:
        Symbol.for("zcode.node-repl.computer-use-bridge")  (@zcode/zcode-cua/node-repl-cua-bridge.js)
      - facade agent.computerUse installed ONLY when requestMeta.runtime_scope !== "subagent"
        (prepareComputerUseRuntimeGlobals; same gate for agent.browsers via ZCODE_PLUGIN_ROOT)
  → NodeReplCuaBroker → ComputerUseRuntime (packages/zcode-cua/index.js)
      admission (pause gate) → broker.js BROKER_METHOD_KINDS allowlist → broker socket
  → signed Helper (dev.acevra.cua-helper, single TCC principal), hardened transport
```

Runtime capture points (each captured ONCE, then creds never re-read from env):

- MCP host: `captureComputerUseRuntimeFromEnvironment()` at `main()` — the plugin host
  restores broker credentials into the node_repl process env exactly for the spawn window,
  then CLEARS them. Consequence: a cell seeing `process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET
=== undefined` proves nothing; the captured runtime holds the creds in memory.
- Core handler: per-session one-shot from the private snapshot
  `getCapturedZCodeCuaBrokerCredentials()` (packages/shared/src/runtimeEnv.ts, captured at
  sanitize time from the agent spawn env).

## 2. Who sets runtime_scope (facade suppression)

- Producer: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-tools.ts` —
  `runtime.config.taskType === "subagent_child" ? "subagent" : "main"`.
- taskType comes from session-create params (`server-operations.ts`, default `"interactive"`).
- Consumer: MCP request meta `com.zcode/request-context`
  (apps/zcode-cli/packages/adapters/src/mcp/index.ts → `runtime_scope`).
- Proven failure mode (2026-10-01): `runtime_scope:"subagent"` on a main-conversation turn ⇒
  bridge symbol present but `agent` undefined ⇒ model sees `ReferenceError: agent is not
defined`. Minimal repair direction (NOT implemented): install the facade unconditionally and
  keep the refusal at call time (`assertAvailable` already throws
  `CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE`).

## 3. State ownership (single owner per fact)

| Fact                                                  | Owner                                                                                                | Projection path                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Lease/admission/pause truth                           | lease authority (services)                                                                           | `lease-authority/authority.ts`            |
| Per-session activity + observation records            | authority `reportActivity` (fed by runtime sideband `reportActivity` in packages/zcode-cua/index.js) | session records                           |
| Mini Computer projection (frame/cursor/action/target) | authority, via `createWorkspaceProjection` (`getWorkspace`)                                          | session view `workspace` section          |
| Session read model                                    | `cuaSessionView.ts` `describeComputerUseSession`                                                     | RPC `getComputerUseSession`               |
| Renderer poll (single, shared, token-fenced, 1s)      | `useComputerUseSession`                                                                              | feeds BOTH surfaces                       |
| Large bar visibility (SAFETY-ONLY)                    | `lib/cuaSessionProjection.ts` `projectComputerUseBar().visible`                                      | render only when native takeover relevant |
| Mini panel relevance                                  | `MiniComputerPanel.tsx` `isAgentWorkspaceActive`                                                     | render only for agent-workspace           |
| Hide/expand (presentation only)                       | `store/miniComputerStore.ts` (session-keyed)                                                         | never touches execution                   |
| Action labels (product-owned)                         | `lib/computerActionLabel.ts` → `chat.computerAction.*` (en-US/zh-CN)                                 | CUA transcript card + mini caption        |
| Classification (BACKGROUND_SAFE…EXCLUSIVE_FOREGROUND) | signed Helper                                                                                        | never downgraded by JS                    |

Bar visibility rule (current): native takeover involvement only — lease reserving/active,
foreground/control method in flight (incl. acquire_control), lease ended (yield/stop),
pause of an active takeover. Observe / get_app_state / screenshot / background semantic /
workspace actions ⇒ NO large bar (mini panel is canonical). Zero-capture invariant: polls read
pure snapshots; frame bytes are fetched once per frame id via the confined
`getComputerUseObservationFrame` read.

## 4. Credential chain + convergence (existing, do not duplicate)

- Agent spawn env: services `resolveSpawnEnv` (node.ts) — darwin lazy Helper start, bounded
  wait, fail-closed `BROKER_UNAVAILABLE` marker; full tuple only when the hardened session is
  helperConnected.
- Bootstrap `sanitizeZCodeRuntimeEnv` captures socket+authority PAIR into the private snapshot
  (half-pair ⇒ fail-closed reset).
- Stale pre-credential agent convergence (already implemented): recycle gate
  `shouldRecycleStaleProvisionedRuntime` (recycle iff CUA enabled AND spawnEnvKeys lack broker
  socket AND Helper/hardened transport ready), triggered by Helper-recovery boundary,
  spawn-settle sweep, and `onCuaExecutionDemand`; never mid-turn (CLI running/waiting session
  or active CUA turn blocks recycle). Test: `packages/services/test/cuaStaleAgentRecovery.test.ts`.

## 5. Symptom → boundary table

| Symptom                                                  | Boundary                                                                                                                                 | First response                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `agent is not defined` (bridge symbol present)           | runtime_scope "subagent" at requestMeta                                                                                                  | inspect serving runtime's taskType; do NOT add credentials                                                       |
| `agent is not defined` mid-session after working cells   | node_repl Worker loaded a foreign `node-repl-host` build (plugin cache re-seeded under the running host by an app sharing the data root) | hash the seeded `server.js` vs repo dist; dev must run on its isolated `ZCODE_HOME`                              |
| glow drops ~5 s after Allow (first heartbeat)            | renewal refused `not_authorized` — method missing from one allowlist (JS `BROKER_METHOD_KINDS` vs Swift `supportedBrokerMethods`)        | run `test/helper-method-allowlist.test.mjs`; rebuild the dev Helper                                              |
| AceVra window hidden + absent from Dock after a takeover | process turned `UIElement` by an overlay's `setVisibleOnAllWorkspaces`                                                                   | `lsappinfo` type; every call must pass `skipTransformProcessType: true`                                          |
| glow drops ~30 s into a quiet hold, model still holding  | authority keepalive never arrives (heartbeat renewal rejected)                                                                           | check `renew_lease` params against Helper `validForegroundBrokerParams`; read authority `lastTermination.reason` |
| `Computer Use is unavailable for this node_repl session` | broker absent in that generation (pre-credential agent)                                                                                  | check convergence/recycle logs; expect self-heal at next boundary                                                |
| `missing_session_capability`                             | broker token not captured at call time                                                                                                   | capture-window bug family (historical, fixed)                                                                    |
| `method 'x' is not available`                            | broker.js `BROKER_METHOD_KINDS` allowlist                                                                                                | add method mapping deliberately                                                                                  |
| facade property not a function                           | flat facade misuse                                                                                                                       | call `CU["computer.workspace_click"]` (property name = tool name)                                                |
| workspace actions refused `target_lost`                  | stale fixture instance                                                                                                                   | restart `WorkspaceFixture.app`, retry once                                                                       |
| uppercase UUID refused                                   | (fixed) case-insensitive regex at both gates                                                                                             | regression: `packages/zcode-cua/test/uppercase-uuid.test.mjs`                                                    |

## 6. Test entry points (run the layer you touched)

```bash
# runtime/bridge/contract (fast, no GUI)
node --test packages/zcode-cua/test/*.test.mjs
# services (authority projection, lease authority)
TSX_TSCONFIG_PATH=packages/services/tsconfig.json mise exec -- node --import tsx --test packages/services/test/<file>.test.ts
# UI (bar, mini panel, labels — deterministic render tests, no Electron)
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/<file>.test.ts
# gates for any change
mise exec -- node scripts/mise-run.mjs pnpm typecheck   # root
pnpm --dir apps/zcode-cli -r typecheck                  # CLI packages are NOT covered by root
pnpm architecture:check --changed
```

## 7. Accepted behaviors — do not reopen

- Mini Computer is the canonical background UI; large bar is safety-only (native takeover).
- Product-owned English/i18n labels win over model-authored titles.
- Notes `set_value`/`type_text` AX refusal is an honest Helper refusal, not a bug.
- Foreground typing on the user's desktop is subject to the measured focus war; per product
  pivot it is the explicit fallback (background-first is the product).
- Zero-steal, zero-capture-polling, session fencing, single shared poller: invariants with
  deterministic tests — keep them green.
