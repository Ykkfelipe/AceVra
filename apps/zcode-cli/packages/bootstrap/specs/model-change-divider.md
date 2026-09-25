# Model-change divider ("Model switched X → Y")

Status: 2026-09-25. The v4 `timelineMarker { type: "modelChange" }` row, rendered by the
desktop/web renderer as "Model switched {from} → {to}". This is separate from the backend
migration marker (`type: "backendTransition"`, see
`packages/services/specs/backend-migration.md`).

## Semantics

A turn's model is the model the turn actually ran on: the admitted selection that
`applySubmissionExecutionState` applies before `TurnStarted`, and that the persisted user
message records as `info.modelSelection`. A divider sits immediately before a turn whose
provider/model identity differs from the previous turn's:

- `from`: the previous turn's model (provider + model id).
- `to`: this turn's model (provider + model id), with `toThought` as its reasoning level.
- Reasoning-level-only changes do not produce a divider.
- A synthetic model-only context message (for example the backend-migration handoff seed) is
  not a turn and never produces or moves a divider.
- An explicit source-less boundary (`previousModelSelection: null`) keeps rendering
  "Using {to}".

The same persisted history must produce identical dividers live, after navigation, after task
reload, and after a full restart (cold hydration). Direction is never inferred from row order.

## Owners and event order

```mermaid
sequenceDiagram
  participant H as Host (setModel / composer submission)
  participant R as CLI runtime (session selection)
  participant P as v4 projection (config, lastTurnModel)
  participant S as Session store
  H->>R: session/setModel(to) (legacy) or switchModelConfig (v4)
  R->>R: setSessionModelSelection(to); pending model_change {from, to}
  R-->>P: ModelSelected{modelSelection: to, previous: from}
  H->>R: sendText(intent.modelSelection = X)
  R->>R: applySubmission: if X ≠ session → set X, reconcile pending {from, X}
  R-->>P: ModelSelected{X} (only when X ≠ session)
  R->>S: persist pending model_change part (dropped when from = X)
  R-->>P: TurnStarted → divider lastTurnModel → config (= X)
  R->>S: user message {modelSelection: X}
  Note over P,S: cold rebuild: turn model = user message selection; a model_change part only fills in when the message has none
```

- The runtime session selection is the single owner of "the next turn's model". Every path
  that changes it outside a turn publishes `ModelSelected`, so the live projection `config`
  never drifts from the runtime (`applySessionModelSelection` in
  `src/zcode-protocol-v4/model-config-mutation.ts`, used by legacy `session/setModel`; it
  mirrors what the v4 `switchModelConfig` handler already emits).
- A pending `model_change` part recorded by `setModel` is reconciled with the submission that
  actually starts the turn (`applySubmissionExecutionState`); it is persisted only if the turn
  really runs on a different model than the previous selection.
- Cold hydration treats the user message's own `modelSelection` as authoritative for that
  turn. A `model_change` part is used only when the message lacks a selection (preface turns,
  legacy data).

## Defects this replaces (2026-09-25)

1. Legacy `session/setModel` (used by the backend-migration readiness step and the desktop
   legacy session service) changed the runtime without `ModelSelected`, so the live projection
   kept the old `config`. The next `TurnStarted` compared the previous turn against that stale
   config and could render a reversed divider (observed: "Azure → Command Code" above a turn
   that ran on Azure).
2. `setModel` recorded a pending `model_change` that the turn's submission could contradict
   (setModel B, then submit A). The part was still persisted, claiming a switch that never ran.
3. Cold hydration preferred such a part over the user message's own selection, so one bad part
   misattributed the turn and shifted every later divider.

Historical parts from before this fix are not rewritten. They render correctly because cold
hydration no longer lets a part override the turn's recorded selection.

## Row numbering and migration segments

Projection row ids come from one sequential counter, and divider rows consume ids. Backend
migration bounds Agent segments by zcode row ids recorded at commit time and relies on those ids
being identical live and after restart. Before this fix, live and cold could emit different
dividers, so a restart could shift later ids and move rows across a recorded boundary (observed:
an Agent segment lost its last assistant reply after restart). After the fix, live and cold emit
the same dividers, so new boundaries stay aligned.

Tasks migrated before the fix keep boundaries recorded under the old live numbering. For those,
the cold numbering changes once (only where a contradicting part existed), which can hide a
divider that lands exactly on a recorded boundary. No message is lost or duplicated, and
transition records are not rewritten: there is no safe deterministic way to re-derive the
original boundaries.

## Accepted scenarios

- Z.ai → Command Code, Command Code → Azure OpenAI, Azure OpenAI → Z.ai: each renders one
  divider in that direction, identical live and after cold hydration.
- Migration: a Codex → Agent(Azure) seed plus `setModel(Azure)` followed by an Azure turn after
  a Command Code turn renders "Command Code → Azure OpenAI" live and after restart; the seed
  itself renders nothing.
- `azure-openai/gpt-5-mini$low` keeps provider `azure-openai`, model `gpt-5-mini`, thought
  `low` in the divider payload.
- A history containing contradicting parts (setModel then a different submission) renders from
  the turns' recorded selections.
