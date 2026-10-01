# Background-first Computer Workspace (agent works while the user keeps the foreground)

Status: proposed. Owner: CUA (packages/zcode-cua + packages/services + packages/ui).
Date: 2026-10-01. Supersedes nothing; extends `specs/computer-use.md`.

## Finish-and-polish milestone (2026-10-01)

The visually accepted Dell Computer pane remains the canonical Computer surface. This milestone
adds the local Mac AgentWorkspace as another producer for that surface; it does not create a
second computer UI or capture the user's arbitrary frontmost desktop.

### Stream contract and source identity

The renderer consumes source-independent latest-frame state. Every source identifies itself as
`local-mac` or `remote-node` and supplies a device/workspace identity, connection/freshness,
monotonic frame sequence, capture timestamp, current frame, logical agent cursor, ownership, and
activity. The source owns capture and reconnect; the shared Computer surface owns presentation
and user input gestures. Dell-specific worker details stay in its adapter.

For `local-mac`, the producer captures the actual AgentWorkspace target window using the signed
Helper's existing ScreenCaptureKit permission and window-scoped capture path. It must not request
or publish a whole-display capture of the user's foreground. Capture lifecycle is bound to the
target window identity: disappearance clears the current frame and reports unavailable; a newly
resolved target starts a fresh sequence/generation so pixels from a prior target cannot flash.
Input routing continues through the existing AgentWorkspace/Helper seam. Background actions must
not acquire the native exclusive foreground lease. Explicit Take control pauses admission and
activates the positively identified target for the user; it does not grant the agent an exclusive
lease or forward pane gestures into the Mac. Give back lifts admission only; it does not move the
user's cursor or automatically reactivate AceVra. Background work resumes through normal routing.

The Helper owns a ScreenCaptureKit `SCStream` per active visual target, nominally 12 fps, with
`showsCursor=false` and a bounded capture queue. A host-only `workspace_stream` broker command
starts/reads/stops that stream through the existing authenticated transport. Untrusted broker
clients cannot call this command. Latest JPEG bytes and metadata are held in memory, not appended
to the observation store. The services adapter validates the session's current pid/window before
each read and supplies a source generation; stale generation responses are discarded. One request
at a time and one retained frame at every stage bound memory and prevent playback backlog.
Closing/hiding the pane stops its capture demand; a Helper-side viewer timeout also stops orphaned
capture. Target selection never falls back to the physical desktop or a different app.

The right pane reports device/workspace and target app, connection and freshness, Idle/Working/
You're in control, real activity, ownership controls supported by that source, and truthful
unavailable states. Product-owned localized labels are used. Local and remote routes never
silently substitute for one another. A task-level target choice takes precedence over defaults.

### Input and evidence rules

`computer.workspace_scroll({pid, delta})` is a bounded AX scrollbar adjustment (`delta` from
-1 to 1, positive down). It requires a unique writable scrollbar and verifies its value;
unsupported/ambiguous targets are refused. It never synthesizes physical wheel input. Double
click, right click, drag and key chords remain outside this background substrate's capability.

The existing normalized input vocabulary is audited per producer. Capabilities are exposed only
when the source can deliver and verify them. A delivered action is not success until a fresh
post-action observation verifies its effect; stale observations, vanished targets, secure fields,
and unsaved/destructive dialogs preserve truthful refusal or uncertainty. Foreground escalation
is an explicit request/decision surfaced to the user, never an automatic retry after a background
failure. Activity labels derive from real action/task events and AceVra-owned i18n.

### State and event order

```text
AgentWorkspace target ── Helper window capture ──┐
                                                  ├─ latest-frame source adapter ─ Computer pane
Dell worker ── remote stream adapter ────────────┘
Agent action → existing owner/admission/router → source adapter → fresh evidence → activity projection
```

Helper remains the local capture/input authority; the remote worker remains the Dell authority;
services retain session ownership/admission and task target routing; each source adapter owns its
connection, frame sequence, target generation, and freshness; the pane is a projection and sends
commands through that adapter's existing service path. Desktop remains continuous; no mobile
replay semantics are changed.

### Acceptance added

- The same right-side Computer pane can select/display local Mac workspace or Dell without
  exposing source-specific engineering controls.
- Local frames always identify and show the AgentWorkspace target window, with visible logical
  cursor/activity and no physical cursor/frontmost-app change during background work.
- Target disappearance/reopen and Dell disconnect/reconnect clear stale frames and restore only
  the current source generation; no cross-device or cross-task frame leakage.
- Local/Dell normalized input and safety matrix reports only measured capabilities. Fixture and
  deterministic checks precede packaging; normal-chat acceptance is required on the installed
  candidate on both sources before alpha-complete status.

## Goal

A persistent agent uses the computer **while the user keeps their own foreground**: the user
watches a video, works, or chats, and never loses focus to the agent. The agent's work happens
in a dedicated **workspace** rendered as a live mini view ("little screen") inside AceVra,
expandable on demand. When an action genuinely cannot run in the background, the agent
escalates through the existing exclusive-foreground lease — visibly, with the proven
instant-yield-to-user semantics.

Reference behavior the product is measured against: Codex / Claude desktop computer use.

## What is already proven (foundation this spec builds on)

Live on the installed `963a9007` candidate, through the sanctioned node_repl cell path:

- Observation → `foreground_geometry` registry id → `acquire_control` confirmed by the Helper
  with the verified `requirement` attestation → lease-authority commit succeeds →
  lease `active`.
- The Computer Use bar renders `exclusiveActive` only after the authority commit, with
  Pause and Stop enabled.
- A genuine physical mouse move by the user interrupts the lease; the bar reports
  `yieldedToUser` with "Your physical input took over. The agent won't reclaim control
  automatically." — no automatic reacquisition.
- Background-safe semantic classification (`BACKGROUND_SAFE`, `BEST_EFFORT_BACKGROUND`,
  `REQUIRES_FOREGROUND`, `EXCLUSIVE_FOREGROUND`) already exists in the Helper contract.

Defect fixes this depends on (committed): uppercase Helper UUID acceptance (`9b70edd`) and
the short-identity `requirement` field (`963a900`).

## The macOS input truth this design must respect

Real synthesized keyboard/pointer events (Quartz/CGEvent) are delivered to the session's
frontmost surface. There is no supported API to deliver them to a background window. Therefore
"background" can only mean one of:

1. **Background semantic actions** — AX-level `press` / `set_value` on background windows
   (already implemented; classification-owned by the Helper). Works for AX-writable targets;
   honestly refused otherwise (e.g. TextEdit's AXValue write refusal observed live).
2. **Workspace-frontmost actions** — the target app is frontmost _on the agent's own virtual
   display_, so synthesized events land on it while the user's physical display keeps the user's
   frontmost app and focus.

The workspace (2) is the mechanism that makes "the agent just works in the background" true
for arbitrary apps, and it is what the mini view shows.

## Architecture

### ComputerBackend (packages/zcode-cua)

Single interface, two implementations, no second protocol stack:

```
interface ComputerBackend {
  capabilities(): BackgroundCapabilityReport;        // per-method, from the Helper
  observe(target: TargetRef): Promise<Observation>;  // existing observe contract
  act(action: Action): Promise<ActionResult>;         // classified, envelope-preserving
}
```

- `NativeCuaBackend` — wraps the current runtime unchanged (background semantics +
  foreground escalation). This is the only backend that talks to the Helper.
- `WorkspaceBackend` — composes `NativeCuaBackend` with the agent workspace: target
  placement, workspace-scoped observation, and background-first routing. It never invents a
  second Helper, broker, lease authority, or credential surface.

### Agent workspace (Helper-owned, macOS)

- A **virtual display** created by the signed Helper (`CGVirtualDisplay`). Apps the agent
  drives are placed on it. The user's physical display, focus, and Spaces are untouched.
- Fallback if the virtual display path is rejected at review: a dedicated offscreen
  Space + AX-only actions (no synthesized events in background mode; escalation still
  available). The routing layer treats the fallback as a capability downgrade, not a
  behavior change.
- **Per-window live capture** via ScreenCaptureKit (existing capture rung) streams the
  workspace surface to the UI for the mini view. Frames reuse the existing observation
  pipeline (`observation_id`, sanitization, preview reader) — no new artifact channel.

### Routing policy (single owner: services layer, classification stays Helper-owned)

For every action, in order:

1. Helper classifies the method/target (`BACKGROUND_SAFE` … `EXCLUSIVE_FOREGROUND`).
2. `BACKGROUND_SAFE` / `BEST_EFFORT_BACKGROUND` → execute as a background semantic action on
   the workspace target.
3. Workspace-frontmost synthesis is permitted only for targets placed on the agent's virtual
   display, and only under an **active exclusive lease scoped to the workspace** — the same
   lease, admission, pause, and yield semantics as today, never a parallel mechanism.
4. `REQUIRES_FOREGROUND` / `EXCLUSIVE_FOREGROUND` on a user-visible target → the existing
   foreground lease flow, unchanged (visible takeover, instant physical yield).
5. Anything else → refuse with the honest envelope. **The router never downgrades a
   classification.** No timeouts papering over classification.

### Mini Computer view (packages/ui)

- An expandable panel in the conversation surface that renders the workspace stream and
  reuses the existing Computer Use bar semantics (`pause`, `stop`, yield states).
- The bar remains the single projection of authoritative state (lease authority + Helper
  activity); the mini view adds pixels, not state. No second state machine in the UI.

## State owners and event order

- Helper: ground truth for classification, observation registry, identity.
- Lease authority: admission (pause/resume), lease lifecycle, activity projection input.
- Services: routing decisions, backend selection, workspace lifecycle.
- UI: projection only (existing bar + new stream view).

Event order for a background action: classify → admission check → workspace-targeted
semantic call → activity report → bar/mini-view projection. For escalation: classify →
begin_acquire → Helper confirm (with `requirement`) → authority commit → UI exclusive →
physical input yields → authority release → UI `yieldedToUser`.

## Security invariants

- No new credential, socket, token, or env surface. The workspace rides the existing broker,
  hardened transport, and lease authority.
- The virtual display is **not** a TCC bypass: capture and AX use the Helper's existing
  grants; nothing observes the user's physical display beyond today's contract.
- Synthesized events require an active exclusive lease exactly as today, regardless of which
  display the target sits on.
- node_repl cells, Bash, and tool env see nothing new (presence-checked in the acceptance
  matrix).

## Acceptance scenarios

1. **Background while user works**: user plays a video in the foreground; the agent types
   into a workspace-placed editor; the user's frontmost app and focus never change
   (InvariantProbe frontmost timeline shows zero steals); the bar shows background activity;
   the mini view streams the workspace.
2. **Escalation with yield**: an action classified `EXCLUSIVE_FOREGROUND` on a user-visible
   target takes the proven lease path; the user's physical input returns control instantly
   (`yieldedToUser`, no reacquisition).
3. **Honest refusal**: a background semantic action against an AX-unwritable target returns
   the refused envelope (as observed with TextEdit AXValue) — surfaced, never faked.
4. **Controls unchanged**: Pause closes admission and releases leases; Stop cleans held
   input; both from the real UI, in background and foreground modes alike.

## Non-goals

- Mobile / `web-remote-replayable` semantics changes.
- Remote sessions, external relay changes.
- Any change to the credential capture, lease-authority policy, or Helper identity model.

## Milestones

- **M1 — ComputerBackend abstraction**: interface, `NativeCuaBackend`, routing with
  classification-preservation tests (router cannot downgrade; escalation preserved).
- **M2A — Workspace substrate**: Helper `workspace_click` / `workspace_type_text`
  (AX + pid-targeted synthesis) with zero-steal evidence; AgentWorkspaceBackend.
- **M2B — Workspace projection**: `createWorkspaceProjection` read model (frame, logical
  cursor, action, target, lifecycle state) fed only by real backend events.
- **M3 — Mini Computer view (implemented on the M2A substrate, no virtual display)**:
  a persistent floating picture-in-picture panel over the conversation, tied to the
  session's workspace. Rules:
  - **Projection only.** The panel renders the workspace projection; it is not a second
    state machine. The host lease authority maintains the projection from the same
    activity reports that feed the Computer Use bar, and the session view carries it
    (`workspace` section) to the owning UI.
  - **Zero capture from UI.** Polling reads snapshots (pure, side-effect free). Frame
    pixels come only from the existing confined observation-frame read, one fetch per
    frame id. UI polling never creates observations.
  - **Zero focus steal.** Rendering the panel activates nothing, moves nothing, and
    acquires no lease. The panel's mode label says "Working in background" for the
    agent-workspace backend; "Exclusive control" appears only when the native lease is
    actually active.
  - **Persistent, not transcript-based.** New frames update the SAME panel. Hiding it
    (×) must not stop the agent, pause execution, or discard state; a reopen affordance
    exists while the workspace is relevant. Expanded view is another presentation of the
    same workspace, never a second session.
  - **Fencing.** Panel state is keyed by session; Task A's frames/cursor never leak into
    Task B's panel.
  - **One canonical Computer UI for background work.** While the session's agent-workspace
    projection is relevant, the floating panel is the Computer UI: the large Computer Use
    bar is not rendered alongside it. If the user hides the panel, only the compact
    reopen affordance ("Working in background · Show Computer") remains. The bar stays
    available for native foreground/exclusive control — including escalation during an
    active workspace — where a prominent safety surface is appropriate. Hiding either
    visual never changes execution state.
  - **Real controls.** Pause/resume/stop write through the existing admission/service
    paths. Take Over (bringing the target app to the user's foreground) is explicit user
    action only.
  - Virtual display remains a future substrate swap (extension point), not a
    prerequisite; snapshot-driven frame updates are acceptable for v1.

- **M4 — Acceptance extension**: background matrix (frontmost-timeline zero-steal proof,
  background semantic pass/refusal truthfulness, escalation-yield replay, pause/stop parity).

## Risks

- `CGVirtualDisplay` is a private API; behavior across macOS upgrades is the main risk and
  the reason the fallback mode is part of the spec, not an afterthought.
- AX coverage varies per app; background mode is honest about coverage rather than
  approximating with foreground synthesis.
- Capture perf on the mini view is bounded by the existing observation limits.
