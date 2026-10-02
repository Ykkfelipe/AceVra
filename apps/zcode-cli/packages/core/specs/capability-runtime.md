# Capability runtime (model ergonomics)

Status: implemented on `release/0.1.0-alpha` (milestone "Capability Runtime / Model Ergonomics").

## Problem

A Computer task whose real execution took seconds spent minutes on guessed API spellings
(`type_text`, `press`, `key_press`, `set_value`, `computer.press`, …). The model had to discover
by failure what exists, under which exact name, with which arguments, on which target, and why
something is refused. That is a harness failure: AceVra already knows all of it
deterministically.

## Product rules

1. The model is told, before its first action, the exact canonical action names and argument
   shapes of the capabilities relevant to the request, and whether each is usable right now.
2. Unavailable capabilities are stated with a truthful reason instead of being omitted or
   advertised; disabled plugins and disconnected MCP servers never advertise actions as usable.
3. Remote targets never masquerade as local capabilities. Computer (this Mac) and
   RemoteComputer (an SSH computer) are separate capabilities with separate targets.
4. Not every capability is dumped into every prompt: a deterministic, explainable relevance
   selection decides which capabilities are spelled out.
5. Skills explain *how* to use a capability well; capabilities say *what* can be done. A
   capability may name related Skills; Skill bodies are never injected by this layer.
6. When the model still calls something that does not exist, the error is structured and says
   what to call instead, so no exploratory call is needed.
7. No model calls. Discovery, selection and rendering are pure and cheap.

## Ownership (no parallel registry)

The capability layer **owns no mutable state**. A snapshot is a pure projection of the
authoritative registries, recomputed per turn:

```text
ToolRegistry (provider-visible contracts, after allow/deny + toolset filtering) ─┐
McpPort.status()  + registered mcp__* tool names ───────────────────────────────┤
PluginReferenceCatalog (frozen at session start; enabled/disabled) ─────────────┤
SkillLoadOutcome (discovered skills) ───────────────────────────────────────────┼─▶ buildCapabilitySnapshot()  (pure)
@zcode/zcode-cua COMPUTER_USE_SURFACE + runtimeFeatures + runtime scope ────────┤        │
ExecutionTargetPort.selectedTarget() / listTargets() (bounded, cached) ─────────┘        ▼
                                                                    CapabilitySnapshot (value object)
                                                                         │
                     ┌───────────────────────────────┬───────────────────┴───────────────┐
                     ▼                               ▼                                   ▼
        selectRelevantCapabilities()        Capabilities tool (read-only)       explainUnknownTool()
        → capability_context reminder       full snapshot on demand              structured not-found
```

Single writers stay where they were: the ToolRegistry decides what is registered, the MCP port
decides connection state, the plugin catalog decides enablement, the CUA package decides the
Computer surface and its availability predicate (`foregroundComputerUseAvailable`). The capability
layer only reads them.

## Contracts

`@zcode/contracts` `capabilities/index.ts`:

- `Capability { id, domain, displayName, source, actions[], availability, unavailableReason?,
  executionTargets[], relatedSkills[], providerVisible, pluginId?, mcpServer?, keywords[] }`
- `CapabilityAction { canonicalName, invocation, description?, argsHint?, inputSchema?,
  availability, unavailableReason?, risk }` where `invocation` is either
  `{ kind: "tool", toolName }` (provider tool name) or
  `{ kind: "node_repl", toolName: "js", expression }` (Computer facade).
- `CapabilitySnapshot { target, capabilities[], diagnostics }`.
- `CapabilityErrorPayload { code: "capability_unavailable" | "tool_not_found", requested,
  capability?, reason, availableActions[], suggestions[] }`.

`source` ∈ `native | computer | mcp | plugin | execution_target`. Plugins never appear as a
capability *kind*: a ZCode-compatible plugin contributes MCP servers / skills / commands /
subagents, and the capabilities they produce carry `pluginId` as provenance only. Compatibility
identifiers (plugin ids, `mcp__…` names, `computer-use@zcode-plugins-official`) are unchanged.

### Canonical names and provider projection

- Native tool: canonical name = registered tool name (already provider-neutral).
- MCP tool: canonical name = registered `mcp__<server>__<tool>` name. The official CUA server
  is projected to `mcp__computer-use__*` by the existing `registerMcpTools`; no new aliases.
- Computer (node_repl facade): canonical name = the `COMPUTER_USE_SURFACE` name
  (`computer.workspace_type_text`), invocation
  `await agent.computerUse["computer.workspace_type_text"](args)`. When the official CUA MCP tool
  is registered too, the action also lists that tool name; there is still one canonical
  operation.
- Provider adapters (`toAiSdkTools`) translate tool contracts for OpenAI / Anthropic /
  OpenAI-compatible (GLM, DeepSeek, Azure, Command Code) at the adapter boundary only. The
  capability reminder is plain text and the `Capabilities` tool is an ordinary strict-schema tool,
  so every provider consumes the same canonical state.

## Availability rules

| Capability | Available when | Unavailable reason (verbatim to model) |
| --- | --- | --- |
| Computer (this Mac), background actions | `runtimeFeatures.computerUse` (plugin enabled) **and** captured verified transport admission (including an idle, lazy-startable Helper), a node_repl tool (`js` or `mcp__node_repl__js`), darwin, main scope | plugin disabled / verified transport unavailable (e.g. headless CLI) / no node_repl / not macOS / subagent |
| Computer foreground actions (`acquire_control`, `click`, `type_text`, `key_press`, …) | local main desktop-continuous session with foreground control allowed; execution still requires one user Allow grant | "screen takeover is only available in a desktop conversation on this Mac (not remote, mobile or replayed sessions); use the background actions instead" |
| MCP server tools | server `connected` and ≥1 provider-visible tool | "MCP server X is <status>" / "no tools visible after allow/deny" |
| Plugin-contributed capabilities | plugin enabled in this session | "plugin P is disabled in this session" (no actions advertised) |
| Execution targets | host injected `ExecutionTargetPort` (desktop, local workspace, main scope) | "this session has no access to the user's other computers" |
| RemoteComputer | registered and ≥1 online SSH target with `computerUse` | per target `unavailableReason` |
| Bash | registered | when a target is selected: "shell runs on <target> via RunOnTarget while this conversation is bound to it" |

## Relevance selection (deterministic)

Input: canonical user text, plugin references, selected target, target display names.
Output: ordered `{ capabilityId, reasons[] }` plus omitted count. Rules, in order:

1. `plugin_reference:<id>` — every capability contributed by a referenced plugin.
2. `selected_target` — execution-target capabilities when the conversation is bound to a node.
3. `target_name:<name>` — a known target display name appears in the text (e.g. "Dell").
4. `keyword:<k>` — a domain lexicon match (English + Chinese), word-boundary aware.
5. `mcp_name:<server>` — an MCP server name token or plugin name appears in the text.

Always-visible native tools (files, shell, search, web) are **not** re-described: their schemas
are already in the provider tool list. They appear in the reminder only when unavailable or
retargeted. At most 6 capabilities and 8 KiB are rendered; the rest are reachable with the
`Capabilities` tool. No match ⇒ no reminder (zero cost on the common path).

Domain hints for local vs remote: a remote-target match (`target_name`, "remote", "other
computer") suppresses the local Computer keyword match unless a local-only keyword ("this Mac",
"local") is also present.

## Model-facing surfaces

1. `capability_context` model-only reminder, injected after the user message (same mechanism and
   persistence as `plugin_reference`, so cold resume reproduces it).
2. `Capabilities` tool (read-only, concurrency-safe): `{ domain?, capability?, includeUnavailable? }`
   → the snapshot (or one capability) with full input schemas.
3. Structured not-found: `Tool not found` results carry
   `<tool_use_error>{"code":"tool_not_found",…}</tool_use_error>` with up to 5 suggestions
   (canonical names, including Computer facade expressions for guessed Computer spellings) and,
   when the name belongs to a known-but-unavailable capability, `code: "capability_unavailable"`
   with the reason and the available actions.

## Observability

- `capability.snapshot.built` (debug): `discoveryMs`, `selectionMs`, counts, selected ids+reasons.
- `capability.turn.metrics` (info, once per turn with tool calls): `invalidToolCalls`
  (not-found + input-validation failures), `discoveryCalls` (`Capabilities` tool +
  `agent.computerUse.describe()` cells), `firstValidToolActionMs` (turn submit → first successful
  non-discovery tool result), `toolSchemaBuildMs` (provider tool list projection).

## Event order (per turn)

```text
user submit ─▶ persist user message ─▶ plugin_reference reminder ─▶ capability_context reminder
           ─▶ model step(s) ─▶ tool results ─▶ metrics accumulate ─▶ turn end: capability.turn.metrics
```

Failure semantics: reminder generation fails open for the conversation (turn proceeds) and
closed for capability claims (nothing is injected on error). `listTargets` is bounded (300 ms)
and cached (60 s); a timeout yields "target list unavailable", never a fabricated list.

## Acceptance

Deterministic fixtures (`core/test/capability-runtime.test.ts`):

- A. "Open Chrome in the background and search for cats" selects Computer with the exact
  background action names; foreground actions are listed unavailable with the Protected
  Foreground reason; no remote capability is selected.
- B. "Run the relevant tests" selects nothing extra (shell/files already provider-visible).
- C. A plugin reference / MCP server name selects that MCP capability with its exact tool names.
- D. "Use my Dell" without an execution-target port yields an explicit unavailable capability.
- Guessed names (`type_text`, `computer.press`, `mcp__computer-use__type_text`, `key_press`)
  produce structured errors whose suggestions contain the canonical action.
- The `Capabilities` tool contract projects through `toAiSdkTools` for openai, anthropic and
  openai-compatible (incl. `requiresMfjsToolSchema`).

Live chat acceptance (A–D) requires an installed candidate; see the milestone report.

## Out of scope

Protected Foreground, new Computer UX, companions, automatic subagent orchestration, cloud VM,
conversation sync, plugin redesign, ZCode namespace purge, marketplace rebrand.

## Dev Computer readiness and complete names

Physical Helper connection and session execution readiness are different facts. A verified,
provisioned transport with a lazy restart owner is available while idle. A missing transport,
disabled plugin, failed verification or failed recovery remains unavailable. The Host owns
transport admission; the capability projection must not infer physical connection from a
captured socket string. Scope, platform and node_repl gates remain unchanged.

The model action list is projected from COMPUTER_USE_SURFACE plus its canonical compatibility
alias map. This includes computer.acquire_control, computer.control_status,
computer.release_control and computer.screenshot without a second handwritten registry.
Aliases retain the target's arguments, risk and availability. Regression scenarios cover
idle provisioned transport, unprovisioned transport, disabled plugin and prepared context names.

The capability foreground predicate uses the bridge's canonical delivery-context defaults.
Absent client/delivery metadata in a local main conversation already executes as
`desktop-continuous` in node_repl; the capability reminder must describe that same context.
Explicit web-remote-replayable, subagent scope and remoteSessionId remain denied. Defaults are
owned by the CUA surface module and consumed by both bridge and capability projection.
