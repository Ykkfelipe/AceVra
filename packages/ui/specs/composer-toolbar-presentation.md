# Composer toolbar presentation

## Scope

This spec covers only the user-facing presentation and accessibility of the V4 conversation
composer action controls. It does not rename runtime backends, protocol values, package identities,
bundle identities, or release identities. The built-in execution backend keeps its stable
`zcode` value; its composer-visible name is generalized to **Agent**.

## Naming boundary

- `chat.toolbar.backend.zcode.label` is the display name for the built-in backend and says `Agent`.
- `chat.toolbar.backend.zcode.description` describes the built-in agent without using the product
  name as the user-facing label.
- Backend values, test IDs, service names, protocol fields, storage values, and internal logs remain
  unchanged.
- The second backend remains **Codex** and remains disabled when the Codex execution service is not
  available.

## Composer action presentation

The composer has two action clusters:

- leading actions: mode selector, Computer Use entry, and background-work entry;
- task options: backend selector, model selector, thought level, and context usage where available.

Both clusters use a semantic `toolbar` role with a localized accessible name. Controls share one
presentation contract:

- compact `h-7` hit target with a `min-w-7` icon-only floor, `rounded-lg`, and content-driven width
  when a text label is visible;
- visible labels must never be clipped by a square width or overlap a neighboring control; narrow
  composer states hide the label and collapse to the icon-only floor;
- outline affordance using semantic surface, border, and hover tokens;
- visible keyboard focus using the repository's input-border-focused ring;
- expanded picker state reflected by the existing Radix state and corresponding surface token;
- `text-ui-*` typography only;
- icon plus text when composer width allows, icon-only in compact mode with an accessible name;
- no raw colors, arbitrary typography, or new height systems.

The Computer Use entry remains a Settings entry, not a direct runtime toggle. Its visible state and
tooltip remain owned by `cuaComposerEntryState`; this presentation spec does not change state
ownership.

Composer entry copy uses the same generalized actor language: task placeholders say **agent**, not
the internal runtime/product name. This is display copy only; runtime identifiers remain unchanged.

## Backend and model clarity

The Agent backend's model picker lists the AceVra plan catalog and selection drives the plan model
as before. For the Codex backend, the composer renders a dedicated Codex model + effort control
instead of the Agent picker, in **both** new-task drafts and existing Codex conversations:

- The model list is the curated `CODEX_MODEL_OPTIONS` contract in `@zcode/shared`
  (`codex-execution.ts`): **Default (Codex app setting)** plus the reviewed ids
  (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`).
  Exact allow-list, not a free-text field; new ids require a contract change.
- Effort uses `CODEX_EFFORT_OPTIONS` (`minimal` / `low` / `medium` / `high`). The Codex
  `ReasoningEffort` schema type is an open string (“advertised by the model”), so the curated list is
  the contract; a value outside it is rejected host-side (fail loud).
- `null/undefined` is the **Default / no override** sentinel: no `model` / `effort` field is sent
  and Codex keeps its own settings.
- Verified against the installed binary (`codex-cli 0.155.0-alpha.16.4`,
  `app-server generate-json-schema` + live handshake):
  - `thread/start` accepts a top-level `model`;
  - `turn/start` accepts `model` and `effort` overrides whose description is “Override the
    model/effort for this turn **and subsequent turns**”, so **mid-session switching is supported**
    (the earlier “thread-level lock” note is superseded);
  - both the `thread/start` response and the `Thread` object in `thread/started` report the
    actually-adopted `model` and `reasoningEffort`.
- The displayed value is therefore Codex's **reported** model/effort (snapshot `config.model` /
  `config.thought`) whenever the user has no explicit override — “which model is answering” is
  never guessed, it is what Codex reported (e.g. the app's config default such as `gpt-6-luna`).
- An explicit override in the session-scoped composer draft is sent as `codexTurnOverride` on the
  v4 `sendText` payload (schema-strict, host validates against the allow-list). Draft task
  creation sends the model via `thread/start` and the effort on the first turn.
- The host fails loud when the installed Codex binary rejects `model` / `effort`; silently falling
  back while displaying a chosen value is a defect.
- Claude is not a backend; no Claude model surface exists or may be implied by this UI.

## Explicit input rejection

`inputRouting.mode = "reject"` is a runtime decision to refuse new input (for example while an
external backend turn is running). When it is active, the composer keeps the editor disabled but
must explain itself: the placeholder states that the agent is working and follow-up input is
paused. Silent locking without copy is a presentation defect.

## Accessibility invariants

- Every icon-only compact state retains an accessible name.
- Picker triggers identify the picker they open; Radix continues to expose expanded state.
- Toolbar clusters expose a toolbar role and localized name so keyboard users can identify the
  group.
- Visual grouping must not create a second state owner or duplicate command admission.
