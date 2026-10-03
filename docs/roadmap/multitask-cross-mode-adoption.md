# Cross-Mode adoption/conformance — Multitask side (Coding → Multitask + returns)

> Status: implemented on `feature/multitask` (additive). Contract: frozen `@zcode/shared/cross-mode`
> snapshot from `feature/cross-mode` @ `b5b4ca1`, synced byte-identical (see below).
> Scope: Multitask branch only. No changes to `feature/cross-mode`, Personal Bot, UI, or
> admission persistence.

## What this milestone delivers

1. **Coding → Multitask consumption** — `buildMultitaskHandoffSubmission(packet, plan)` maps a valid
   `coding → multitask` `HandoffPacket` into the stable Multitask M1 submission surface
   (`MultitaskInput`), reusing the frozen contract's transfer validation instead of redefining it.
2. **Multitask → Coding returns** — `buildMultitaskHandoffReturn(packet, outcome)` produces a valid
   `HandoffReturnSummary` v1; `partial` passes through honestly and `returnPolicy` governs the shape.
3. **The exact adapter surface** a future `HandoffExecutionPort` implementation should call (below).
4. Conformance suite + a contract snapshot guard against local drift.

## Contract snapshot (why the module is present on this branch)

The frozen contract lived only on `feature/cross-mode`. To adopt and test against it *now* — without
merging that branch and without modifying it — the exact `b5b4ca1` files were synced additively:

- `packages/shared/src/cross-mode/**` — 10 files, byte-identical (blob hashes below);
- `packages/shared/src/index.ts` and `packages/shared/package.json` — the same additive lines as on
  the cross-mode branch.

Because the copies are byte-identical, the later integration merge is a no-op for these files
(identical blobs dedupe cleanly). `feature/cross-mode` was neither modified nor merged.

| File | blob (== b5b4ca1) |
| --- | --- |
| `modes.ts` | `87e494aecc744d95c4942e1812bd62f13191c7de` |
| `errors.ts` | `2669ef0b530cbfac2096dfc2f9783407f94d550c` |
| `context.ts` | `f6c7189c74138f057d658883238575641571561f` |
| `handoff-packet.ts` | `924c1c63bc5f6b2397a5e0f52c88354dfa3ecf64` |
| `handoff-return.ts` | `93216513c690b8d7cb35a1d471947d4a2d7543c0` |
| `flow-errors.ts` | `8a0aa08c0670f25a9cb34710cc3a6ba0d18536fc` |
| `ports.ts` | `4ed0d1b1f689462e9a585bc58ea8bcdfe6c8e964` |
| `preview-session.ts` | `857f23a8b70673754d6018232fe0de081f357e6e` |
| `admission.ts` | `a1f134aba846b64dd6d257c30c494452430a5901` |
| `index.ts` | `06173b08fcdce5d92a7d4ae342864546c74aa212` |

## Adapter surface (for the future `HandoffExecutionPort` implementation)

Location: `apps/zcode-cli/packages/core/src/cross-mode/` — exported through `@zcode/core`.

```ts
// Coding → Multitask
export function buildMultitaskHandoffSubmission(
  packet: HandoffPacket,          // 冻结契约类型（@zcode/shared/cross-mode）
  plan: MultitaskHandoffPlan,     // { name?, workers[], tasks[] }：由 destination 协调方提供
): MultitaskHandoffBuildResult;   // ok → MultitaskHandoffSubmission { input, handoffId, linkedProject, returnPolicy, sourceRefs }

// Multitask → Coding
export function buildMultitaskHandoffReturn(
  packet: HandoffPacket,
  outcome: MultitaskHandoffRunOutcome, // status(frozen) + summary + notes/verification/artifacts
): HandoffReturnSummary | null;  // null when returnPolicy === "none"
```

Executor wiring guide:

1. Receive the M2 `HandoffExecutionRequest` (`{ packet, confirmedAt }`).
2. Pre-check with the frozen admission: `assertHandoffPacketTransferable(packet)`.
3. Build the submission: `buildMultitaskHandoffSubmission(packet, plan)` — the worker/task `plan`
   comes from the destination coordinator (the frozen packet carries no graph, by design).
4. Submit `submission.input` through the existing Multitask admission path (identical to an
   interactive `Multitask` tool call: profile/model resolution → script lowering → run confirmation).
5. On acceptance return `{ status: "accepted", externalRef: { kind: "multitask-run", id: <runId> } }`.
6. On completion call `buildMultitaskHandoffReturn(packet, outcome)` and record it via the M2
   admission service's `recordReturn`.

## Field mapping (frozen packet → Multitask M1 surface)

| HandoffPacket field | Multitask M1 surface | Rule |
| --- | --- | --- |
| `sourceMode` → `destinationMode` | — (flow gate) | only `coding → multitask` is consumed; otherwise `multitask_handoff_wrong_flow` |
| `objective` | `objective` (+ derived `name`) | name deterministic: `Handoff: <objective ≤100 chars>`; plan may override |
| `context` | `sharedContext` "Context to carry" | **only included items**; excluded items never enter the run |
| `sourceRefs` | `sharedContext` "Source refs:" | provenance retained (mandatory in contract) |
| `constraints` | `sharedContext` "Constraints:" | |
| `permissions` | worker `access` gate | reader requires `repo-read`; writer requires `repo-read` + `repo-write` |
| `linkedProject` | `sharedContext` + submission accessor | required by frozen admission for coding→multitask |
| `returnPolicy` | return builder shape | `none` → null; `summary` → artifacts dropped; `summary-and-artifacts` → kept |
| `handoffId` | submission accessor + `sharedContext` header | backlink convention for returns |

## Contract mismatch notes

No blocking mismatch. Three seams are worth stating explicitly:

- `MultitaskInput` has no structured provenance field; handoff provenance is folded into the
  `sharedContext` text. If a structured link is wanted later, that is a Multitask surface change,
  not a cross-mode contract change.
- The frozen contract carries no worker/task graph. Plan ownership stays with the destination
  coordinator — consistent with Multitask M1's "minimum useful worker set" rule.
- Run backlink convention is `{ kind: "multitask-run", id }` — already one of the frozen object kinds.

## Verification

- Conformance suite: `apps/zcode-cli/packages/core/test/multitask-handoff.test.ts` — 9 tests
  (snapshot guard, field mapping incl. least-context, project linkage, permission gates,
  completed/partial returns, returnPolicy shapes, executor smoke).
- Multitask regression: `multitask.test.ts` + `multitask-runtime.test.ts` + conformance —
  27 tests passed, 0 failed (`mise exec -- node --import tsx --test …`).
- Typecheck: `turbo run typecheck --filter=@zcode/contracts --filter=@zcode/core --filter=@zcode/bootstrap`
  — result recorded in the milestone report.

## Out of scope / next

- `HandoffExecutionPort` implementation itself (this milestone only fixes the surface it should call).
- UI entry points, Personal Bot adoption, persisted admission storage — untouched by design.
