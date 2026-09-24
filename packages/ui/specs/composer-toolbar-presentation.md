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

## Accessibility invariants

- Every icon-only compact state retains an accessible name.
- Picker triggers identify the picker they open; Radix continues to expose expanded state.
- Toolbar clusters expose a toolbar role and localized name so keyboard users can identify the
  group.
- Visual grouping must not create a second state owner or duplicate command admission.
