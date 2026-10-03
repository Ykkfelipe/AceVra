# Cross-Mode Continuity — M1 contract spec (HandoffPacket v1)

> Roadmap: `docs/roadmap/cross-mode-continuity.md`. This spec covers **milestone 1 only**:
> the versioned cross-mode contract and its boundaries. It does not ship mode switching,
> work execution, UI wiring, or object-graph persistence.
>
> Contract module: `packages/shared/src/cross-mode/` (branch `feature/cross-mode`).

## 1. Product rule for M1

AceVra has three user-facing modes — **Bot**, **Coding Sessions**, **Multitask**. Cross-Mode
Continuity lets work move between them through a structured, inspectable handoff instead of
copy/pasting conversation history.

M1 fixes the contract that all four conceptual flows need, before any mode is wired:

```text
Bot → Coding            (turn an idea/goal into real project work)
Coding → Multitask      (split growing work into bounded workers)
Multitask → Coding      (return results into the originating coding context)
Work → Bot              (bring a concise project-level result back to Ace)
```

This milestone ships **contracts and boundaries only**:

1. stable mode IDs and cross-mode object references;
2. a typed, versioned `HandoffPacket` (source/destination mode, objective, selected context,
   provenance, constraints, permissions, linked project, return policy);
3. context selection with privacy defaults, preview and edit primitives enforcing
   least-context caps;
4. a `HandoffReturnSummary` envelope for the `Multitask → Coding` and `Work → Bot` returns;
5. canonical serialization, runtime validation, deterministic issue reporting, and unit tests.

It explicitly does **not** ship: mode switching or work spawning, any UI, any integration with
the concurrently developed `feature/personal-bot` / `feature/multitask` branches, object-graph
persistence, or Computer Use changes.

## 2. Boundaries (non-goals as hard rules)

- **No silent switching.** The contract layer never executes anything; initiating a handoff
  remains an explicit, user-visible action in a later milestone.
- **No context dumping.** A packet has no field for messages, transcripts, or "all memory".
  Context is only explicit, labeled, user-inspectable units. Producers must not bypass this by
  pasting transcripts into `objective` or `constraints`.
- **No deep wiring yet.** The contract is designed so Bot/Multitask adoption later is additive:
  they consume `@zcode/shared/cross-mode`; the contract never depends on their implementations.

## 3. Ownership (one owner per piece of state)

| State / behavior                         | Owner                                           | Notes                                                                                  |
| ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Mode IDs, object refs, flow matrix       | `cross-mode/modes.ts`                           | String IDs are stable; extensions are contract-version changes.                        |
| Packet shape + structural validation     | `cross-mode/handoff-packet.ts`                  | zod schema is the single source of truth; strict, no unknown keys.                     |
| Context item shape, limits, preview/edit | `cross-mode/context.ts`                         | Byte budget and selection policy live here only; consumers must not re-implement them. |
| Issue codes + error type                 | `cross-mode/errors.ts`                          | Closed code set; deterministic sorting.                                                |
| Return envelope                          | `cross-mode/handoff-return.ts`                  | Concise result summary; never a transcript.                                            |
| Which context items exist for a handoff  | Producing mode (Bot / Coding / Multitask) later | Must create items via `createHandoffContextItem` (privacy defaults + caps).            |
| Preview dialog / backlink UI             | UI, later milestone                             | Consumes `buildHandoffContextPreview` + edit ops; no local scoring.                    |
| Transfer admission                       | Coordinator path, later milestone               | Must call `validateHandoffPacketTransfer` / `assertHandoffPacketTransferable`.         |

## 4. Contract summary

### 4.1 Modes and object references

- Modes: `"bot" | "coding" | "multitask"` (`ACEVRA_MODES`).
- Object kinds (roadmap object graph): `goal`, `project`, `idea`, `coding-session`,
  `multitask-run`, `decision`, `artifact`, `conversation`.
- `HandoffObjectRef = { kind, id }`; IDs are opaque (1–200 chars, `[A-Za-z0-9._:-]`, must start
  alphanumeric). Display/serialization helper: `handoffObjectRefKey` → `"kind:id"`
  (`parseHandoffObjectRef` splits at the first `:`).

### 4.2 Flow matrix (v1, closed)

| Source → Destination | Direction | Meaning                                            |
| -------------------- | --------- | -------------------------------------------------- |
| bot → coding         | transfer  | idea/goal becomes project work                     |
| coding → multitask   | transfer  | growing work split to workers                      |
| multitask → coding   | return    | results flow into the originating coding context   |
| coding → bot         | return    | project-level result returns to Ace ("Work → Bot") |
| multitask → bot      | return    | run-level result returns to Ace ("Work → Bot")     |
| any same-mode        | —         | rejected (`handoff_same_mode`)                     |
| bot → multitask      | —         | not in v1 (`handoff_transition_not_allowed`)       |

`handoffDirection(source, destination)` classifies transitions; `null` when not allowed.

### 4.3 HandoffPacket v1 fields

| Field                            | Type / bounds                                      | Notes                                                              |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `version`                        | `"handoff-packet/v1"`                              | literal; unknown versions throw `handoff_version_unsupported`.     |
| `handoffId`                      | 1–64 chars                                         | generated (`createUuid`) unless provided.                          |
| `createdAt`                      | int ≥ 0                                            | ms epoch; generated.                                               |
| `sourceMode` / `destinationMode` | `AceVraMode`                                       | must satisfy the flow matrix.                                      |
| `objective`                      | 1–500 chars                                        | the focused task statement.                                        |
| `context`                        | ≤ 32 items                                         | selected context (see 4.4).                                        |
| `sourceRefs`                     | ≤ 16 refs, ≥ 1 at transfer                         | provenance; mandatory for transfer.                                |
| `constraints`                    | ≤ 12 strings, each ≤ 300 chars                     | duplicates warn, don't block.                                      |
| `permissions`                    | ≤ 8 of `repo-read` / `repo-write`                  | `repo-write` requires `repo-read`.                                 |
| `linkedProject`                  | `HandoffObjectRef(kind:"project")` or `null`       | required for coding→multitask; must not use another kind.          |
| `returnPolicy`                   | `"summary"` / `"summary-and-artifacts"` / `"none"` | return expectation; target is always the handoff's source context. |

Two API layers:

- **Schema layer** (`createHandoffPacket`, `parseHandoffPacket`, `safeParseHandoffPacket`,
  `serializeHandoffPacket`, `deserializeHandoffPacket`): construction and (de)serialization.
  Construction produces a _draft_; schemas are strict and bounded.
- **Admission layer** (`validateHandoffPacketTransfer`, `isHandoffPacketTransferable`,
  `assertHandoffPacketTransferable`): semantic rules listed above; only a packet that passes
  admission may actually initiate a transfer.

Serialization is canonical: fixed key order, compact JSON, same packet → byte-identical output;
`parse(serialize(p))` round-trips.

### 4.4 Context items, limits and privacy

`HandoffContextItem = { id, label, content, sensitivity, included, inclusion, provenance }`.

- `sensitivity`: `standard` | `personal` | `sensitive`.
- `inclusion`: `"auto"` (default policy decided) vs `"user"` (explicitly decided).
  An included non-standard item **must** have `inclusion: "user"` (`handoff_sensitive_auto_included`
  otherwise). Default policy: `standard` → included; `personal`/`sensitive` → excluded.
- v1 limits (UTF-8 bytes, counted over **included** content only; labels/provenance are free):

| Limit                         | Value                                                                      |
| ----------------------------- | -------------------------------------------------------------------------- |
| max items (per packet)        | 32                                                                         |
| max included items            | 16                                                                         |
| max bytes per included item   | 2048                                                                       |
| max total included bytes      | 8192                                                                       |
| max provenance refs per item  | 8                                                                          |
| label / content schema bounds | 120 / 6000 chars (loose structural bound; the byte budget is the real cap) |

Preview/edit primitives (pure, non-mutating):

- `buildHandoffContextPreview` → per-item label/content/sensitivity/inclusion/provenance
  (formatted keys) plus bytes, counts, limits and violations — the data plane for the
  roadmap's "Move to Coding Session / Context to carry" dialog.
- `setHandoffContextItemIncluded` (records `"user"`), `updateHandoffContextItemContent`,
  `removeHandoffContextItem`, `addHandoffContextItem` (defaults per sensitivity, capacity-checked).

### 4.5 HandoffReturnSummary v1

For `multitask → coding` and `coding/multitask → bot` returns: `{ version, handoffId, returnedAt,
status, summary, changes[], decisions[], verification[], unresolved[], blockers[], artifacts[] }`.

- `status`: `completed | partial | failed | cancelled` (partial results must not pretend full completion).
- Notes are ≤ 500 chars with optional refs; verification entries carry
  `passed | failed | not_run`; everything bounded (see schema).
- `handoffReturnMatchesPacket(summary, packet)` ties a return to its originating packet.

## 5. Failure semantics

| Failure                                         | Behaviour                                                  |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Unknown packet/return version                   | `HandoffContractError` `handoff_version_unsupported`.      |
| Unparseable JSON                                | `handoff_json_invalid`.                                    |
| Schema violation (unknown key, out-of-bounds)   | `handoff_schema_invalid` with per-issue paths.             |
| Same-mode / disallowed transition               | `handoff_same_mode` / `handoff_transition_not_allowed`.    |
| Sensitive included without explicit user action | `handoff_sensitive_auto_included`.                         |
| Byte/count budget exceeded                      | `handoff_context_*` limit codes (never silent truncation). |
| Missing provenance                              | `handoff_source_refs_required`.                            |
| Edit op on unknown item id                      | `handoff_context_item_not_found`.                          |
| Invalid edited content / duplicate id           | `handoff_context_item_invalid`.                            |

All validation output is deterministically sorted (`handoffIssuesSorted`); warnings never block
admission (`handoff_constraint_duplicated` is the only warning in v1).

## 6. Versioning policy

- Versions are literal strings (`handoff-packet/v1`, `handoff-return/v1`); schemas are strict.
- Additive or breaking shape changes require a **new version literal** plus an explicit migration
  helper; v1 stays frozen. Consumers must reject unknown versions rather than guessing.
- Mode IDs and object-kind strings are part of the version contract and must never be renamed.

## 7. Acceptance scenarios (M1)

1. A bot→coding packet with two context items (one standard included, one personal excluded)
   serializes, round-trips, and passes transfer validation; flipping the personal item to
   included with `inclusion: "user"` keeps it valid.
2. Including a personal item with `inclusion: "auto"` fails with `handoff_sensitive_auto_included`.
3. 17 included items, a 2049-byte item, or >8192 total included bytes each fail with their
   specific limit code; 2046-byte multibyte content passes.
4. A coding→multitask packet without `linkedProject` fails; with a `project` ref it passes.
5. `repo-write` without `repo-read` fails; duplicate constraints produce a warning only.
6. Same-mode and bot→multitask packets fail; `assertHandoffPacketTransferable` throws with the
   sorted error list.
7. Serializing twice yields identical bytes; deserializing an unknown version fails closed.
8. All of the above are covered by `packages/shared/test/crossMode*.test.ts` (28 tests).

## 8. Adoption checklist (later milestones)

- **Bot**: build `sourceRefs` from the conversation/idea/goal; select context via
  `createHandoffContextItem` (never bulk memory); let the user confirm in the preview.
- **Coding sessions**: produce coding→multitask packets via the contract; returns adopt
  `HandoffReturnSummary`; never grow the packet with transcript fields.
- **Multitask**: build multitask→coding/bot returns as `HandoffReturnSummary` linked by
  `handoffId`; keep worker details out of the summary.
- **UI**: render `buildHandoffContextPreview`; edits go through the edit ops; entry points must
  show provenance (`Started from: Bot → Idea: ...`); handoffs are explicit user actions only.
- **Coordinator/admission** (whoever executes handoffs later): call
  `assertHandoffPacketTransferable` before initiating; do not re-implement caps, scoring, or
  issue codes locally.

## 9. Deferred

- Bot→Coding / Coding→Multitask execution and session creation.
- Context-preview dialog, status cards, backlinks, "Take to Work" entry points.
- Persistent Project/Idea/Goal object graph and handoff history store.
- Interruption/resume status and device-routing metadata.
- Any integration with `feature/personal-bot` or `feature/multitask` branch code.
