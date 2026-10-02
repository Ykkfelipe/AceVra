# Background-first Computer Workspace (agent works while the user keeps the foreground)

Status: proposed. Owner: CUA (packages/zcode-cua + packages/services + packages/ui).
Date: 2026-10-01. Supersedes nothing; extends `specs/computer-use.md`.

## Finish-and-polish milestone (2026-10-01, product-corrected)

There are two distinct Computer experiences, and their presentation must not be shared:

- **RemoteComputerPane** — the existing right-side Computer pane / Computer tab. It is a
  remote-computer viewer/controller for Dell, and future remote machines (Mac mini, mini PC,
  cloud). Local Mac is never an entry, source, or target in this surface.
- **LocalComputerPreview** — the floating mini Computer panel over the active conversation
  (the M3 "little screen"). It is the only surface for local Mac AgentWorkspace work.

Low-level streaming primitives are shared (frame lifecycle, latest-frame admission, cursor
events, the signed Helper capture path); product surfaces are separate.

### Stream contract and source identity

The renderer consumes source-independent latest-frame state. Every source identifies itself as
`local-mac` or `remote-node` and supplies a device/workspace identity, connection/freshness,
monotonic frame sequence, capture timestamp, current frame, logical agent cursor, ownership, and
activity. The source owns capture and reconnect; each product surface owns only presentation.
Dell-specific worker details stay in its adapter; local-Mac details stay in the local preview
adapter. `local-mac`/`remote-node` branching belongs in adapters, never in the RemoteComputerPane.

For `local-mac`, the producer captures the actual AgentWorkspace target window using the signed
Helper's existing ScreenCaptureKit permission and window-scoped capture path. It must not request
or publish a whole-display capture of the user's foreground, the AceVra window itself, or any app
the agent is not operating. The preview shows only the window the agent is operating; when the
target changes (e.g. Chrome → Notes) the preview transitions to the new target. Capture lifecycle
is bound to the target window identity: disappearance clears the current frame and reports
unavailable; a newly resolved target starts a fresh sequence/generation so pixels from a prior
target cannot flash. Input routing continues through the existing AgentWorkspace/Helper seam.
Background actions must not acquire the native exclusive foreground lease. The local preview
exposes no remote-computer concepts: no device selector, no SSH/connection chrome, no
Take control/Give back semantics. Its controls are Pause and Stop (plus Expand; hide/reopen is
presentation-only), backed by the existing admission-level commands; Stop also stops the owning
chat turn through the existing task stop command. Closing/hiding the preview never stops that
turn. A future explicit "open the actual window" action may be added later; it is not part of
this milestone and Take control/Give back must not be reintroduced for local.

The Helper owns a ScreenCaptureKit `SCStream` per active visual target, nominally 12 fps, with
`showsCursor=false` and a bounded capture queue. A host-only `workspace_stream` broker command
starts/reads/stops that stream through the existing authenticated transport. Untrusted broker
clients cannot call this command. Latest JPEG bytes and metadata are held in memory, not appended
to the observation store. The services adapter validates the session's current pid/window before
each read and supplies a source generation; stale generation responses are discarded. One request
at a time and one retained frame at every stage bound memory and prevent playback backlog.
Closing/hiding the preview stops its capture demand; a Helper-side viewer timeout also stops
orphaned capture. Target selection never falls back to the physical desktop or a different app.
Transport ownership (2026-10-01, resolved): on macOS the window-scoped Local Host's services graph
owns the hardened CUA-1.75 Helper session (`hardenedCuaHelperSession`, the same session whose
tuple is injected into the agent spawn env). The managed MCP-host Helper lifecycle is never
acquired on darwin by design, so the stream adapter must not depend on it. `workspace_stream` is
called in-process through that hardened session's trusted `host.callMethod` (the host-only gate
in `host-transport.js` admits it only on the trusted path); the managed host's
`queryWorkspaceStream` is only a secondary holder. The renderer reaches the adapter through the
existing `cuaPermissionService.getComputerWorkspaceStream` RPC and never touches Helper transport.
No second Helper, TCC identity or capture process exists. Sustained stream traffic is a new load
on the hardened relay: the host-transport first-line router must detach once a connection's role
is decided (a still-attached router accumulated every Helper response byte and crashed the window
host with `RangeError: Invalid string length` after a few minutes of streaming). The adapter exposes only `read` and
`stop`: local has no Take control/Give back, and the Helper's `take_control` operation is not
reachable from the product.

The LocalComputerPreview consumes the stream, not the screen-scoped observation projection: the
observation frame is never shown as the live preview. The preview polls `read` (one request in
flight, ~80 ms cadence ⇒ up to the Helper's 12 fps) with `afterSeq` so unchanged frames carry no
bytes; it admits frames by strictly increasing `seq` within one `generation:pid:windowId` source
identity and drops the current frame on any identity change or unavailable status. Hiding the
preview stops the demand (`stop`), and the Helper viewer timeout covers a vanished renderer.
The logical agent cursor is the workspace projection's cursor (global AX points from the last
workspace action, reset by the projection on target switch). The preview positions it relative to
the stream's own window geometry (`originX/originY/pointWidth/pointHeight` returned with each
read), accepts cursor updates only with non-decreasing `updatedAt` within one source identity,
and hides it when it falls outside the captured window. It never reads or moves the physical
cursor.

The local preview reports the target app, live/working state, freshness, real activity, and
truthful unavailable states, with product-owned localized labels. It appears automatically when
a local Computer task becomes active, remains visible while that task runs (even as the
conversation produces text), and its visibility/expanded state is session-keyed presentation
state (not owned by any transcript message), so a later detach/always-on-top surface can reuse
the same ownership. Local and remote routes never silently substitute for one another; a
task-level target choice takes precedence over defaults.

### LocalComputerPreview presentation: floating window (2026-10-01)

The preview is a projection of the session's local Computer state, not a transcript message and
not the owner of the session. One owner per fact:

- session facts (target, frame stream, logical cursor, activity, pause/stop) — host projection +
  the window stream hook, mounted once per conversation (`MiniComputerPanel`, wired component);
- presentation (compact/expanded, position, width, hidden, stopped-dismissal) —
  `miniComputerStore`, keyed by session id. A future detached native window subscribes to the
  same session facts and its own presentation entry; nothing here is tied to a message row.

Floating: the panel renders through a portal into the document body with fixed coordinates, so
dragging never reflows the chat and transcript updates never recreate it. Drag starts only on the
title bar's drag area (buttons and the live frame never start a drag); the position updates via a
transform during the drag and is committed to the store on release, clamped to the app window
with an 8 px margin, and re-clamped when the window shrinks. Resize is a corner handle that
changes width only; the frame height follows the stream's aspect ratio (fallback 16:10), so the
image is never letterboxed or distorted and cursor percentages map 1:1 onto window pixels. Width
is bounded (260 px … min(640 px, window − 16 px)). Expanded is the same element tree in a larger
centred rect (≤ window − 96 px wide, frame ≤ window height − 160 px) with an explicit Restore; it
never remounts the frame, never opens a second stream and never enters the RemoteComputerPane.
None of these interactions touch the stream hook, so stream sequence and cursor state persist.

Lifecycle: Pause keeps the preview; Stop ends the turn and the Computer control, shows a brief
"Stopped" state (~1.5 s) and dismisses; a completed task shows "Done" for a short relevance window
(8 s) and dismisses. × hides the preview (the task keeps running) and leaves a reopen chip — it is
semantically distinct from Stop.

### Input and evidence rules

Delayed self-activation (2026-10-01, measured on f4fdd904): some apps activate themselves shortly
after a background AX action (Chrome raised itself ~100 ms after an AXPress on "New Tab"). The
Helper's immediate before/after sample cannot see that, and `NSWorkspace.frontmostApplication`
does not refresh while a broker command runs. Every background action (semantic `press` /
`set_value`, `workspace_click` / `workspace_type_text`) therefore ends with a bounded settle check
(~350 ms) on the live AX system-wide focused application. If the acted-on target app took the
foreground, the Helper re-activates the app that was frontmost before the action (product
decision: detect + restore) and reports `foreground_settle {stolen, restored}`; the action's
delivery is then `foreground_changed`, never a silent pass. If a different app became frontmost
(the user switching apps), it is reported but never fought.

Logical cursor for semantic actions: `press` / `set_value` carry only a `semantic_ref`. The
runtime records `semantic_ref → {pid, element centre}` from the session's latest observation tree
(global AX points) and reports that target and cursor on completion, so the preview cursor follows
semantic work as well as `workspace_*`. These methods update an existing workspace projection
only; they never create one.

`computer.workspace_scroll({pid, delta})` is a bounded AX scrollbar adjustment (`delta` from
-1 to 1, positive down). It requires a unique writable scrollbar and verifies its value;
unsupported/ambiguous targets are refused. It never synthesizes physical wheel input. Double
click, right click, drag and key chords remain outside this background substrate's capability.

`computer.open_app({bundle_id})` (2026-10-02) is the local counterpart of the remote runtime's
process spawn: launch an app in the background, or hand a running-but-windowless app (browsers
keep the process alive after the last window closes) its window back. It delivers the
LaunchServices open/reopen event with `activates=false`, polls for a usable window (layer 0,
short edge ≥40pt — the same filter as `list_windows`), and applies the foreground settle/restore
guard because some apps self-activate after reopen. Effect is confirmed only when a usable window
appeared; a no-window result is `failed`/`unknown`, never success. The model-visible guidance:
before observing a target that is not running or has no window, call `open_app` instead of
falling back to desktop takeover.

The existing normalized input vocabulary is audited per producer. Capabilities are exposed only
when the source can deliver and verify them. A delivered action is not success until a fresh
post-action observation verifies its effect; stale observations, vanished targets, secure fields,
and unsaved/destructive dialogs preserve truthful refusal or uncertainty. Foreground escalation
is an explicit request/decision surfaced to the user, never an automatic retry after a background
failure. The LLM never consumes every preview frame: the human preview is continuous/sampled for
display, agent observations remain the sampled/verified channel, and post-action verification
waits for a frame/observation fresher than the action. Activity labels derive from real
action/task events through one central normalization boundary (ActivityEventNormalizer): known
system operations render AceVra-owned locale labels and never model-authored titles; assistant
prose is untouched; no hidden chain-of-thought is rendered.

### Model-visible API surface (2026-10-01)

Measured on f4fdd904: Computer tools ran ~7 s of a ~300 s turn; the rest was the model guessing
names and shapes. Causes: the skill showed `computer.press(...)` as if `computer` were an object
and told the model to read `state.text` / `state.state_id` (neither exists); the facade Proxy made
every property look like a function while `Object.keys` listed nothing; refusals said only
"arguments are invalid"; nothing said that background work has no key presses, so the model
probed `key_press`/`type_text` shapes and then fell back to AppleScript.

One table, `COMPUTER_USE_SURFACE` (capability-contract.js), owns the exact names, kinds
(read / background / foreground) and argument shapes. It feeds: the facade's enumerable keys
(only canonical names plus the `press`/`set_value` compatibility aliases are callable; unknown
names are `undefined`); `await agent.computerUse.describe()`, answered by the runtime without the
Helper, returning the surface with this session's real availability (foreground only in a local
main desktop-continuous task with the host capability) and `COMPUTER_USE_LIMITS`; and every
refusal, which now names the expected arguments and the lease step. The skill documents the exact
call syntax, the MCP result shape, the no-background-keys limit, and the product rule not to drive
apps with osascript/AppleScript during a Computer task.

### Transcript labeling for js-executed Computer actions

Computer Use actions execute as `mcp__node_repl__js` cells, so their normal-chat row is rendered
by the node-repl tool card rather than the CUA card. The canonical operation identity is recorded
by the host, not inferred from result shapes: the node_repl CUA bridge records the method of every
Computer Use call it executes (`recordCuaOperation`, canonicalized through
`COMPUTER_USE_MODEL_TO_METHOD`, e.g. `get_app_state` ⇒ `observe`; last call in a cell wins, same as
the app identity), the node_repl host publishes it under the host-only `_meta` key
`zcode/nodeReplCuaOperation` (REPL code cannot forge it — the key is deleted and re-set from the
run, exactly like `zcode/nodeReplCuaApp`), and core projects it as `cuaOperation` on the
`node_repl_images` display. One label boundary (`computerActionLabel`) maps that operation to an
AceVra-owned localized label, interpolating the target app when the display carries a trusted app
name ("Looking at Notes", "Typing in Notes"). A structured result `operation` field remains a
fallback for rows persisted before this field existed. A Computer Use cell whose operation is not
in the label table renders the generic "Using the computer" label.

Model-authored `input.title` never appears on a js cell row, in any state or locale (the model
often titles cells in Chinese even in an English session). A running cell (operation not yet
known) shows the generic "Working" label; a completed non-Computer cell shows the generic
completion label; the cell code remains available in the expanded details.
Assistant prose and reasoning rendering are untouched. The CUA group card's accessible title uses
the same product label and never falls back to `toolCall.title`; the mini panel caption uses the
same `computerActionLabel` boundary.

### State and event order

```text
AgentWorkspace target (projection pid/window, cursor) ─┐
Helper SCStream (window-scoped) ── workspace_stream ── hardened session callMethod (Local Host) ── stream adapter ── cuaPermissionService RPC ── LocalComputerPreview (floating, conversation-scoped)
Helper observation (screen/window observe) ── agent observation channel only (never the live preview)
Dell worker ── remote stream adapter ── RemoteComputerPane (right side; remote devices only)
Agent action → existing owner/admission/router → fresh evidence → activity projection → ActivityEventNormalizer → UI
```

Helper remains the local capture/input authority; the remote worker remains the Dell authority;
services retain session ownership/admission and task target routing; each source adapter owns its
connection, frame sequence, target generation, and freshness; the preview and the pane are
projections and send commands through their adapters' existing service paths. Desktop remains
continuous; no mobile replay semantics are changed.

### Acceptance added

- A normal-chat local Computer task (e.g. background Chrome, then Notes) shows the floating
  LocalComputerPreview — never a right-pane entry — with the target window live, the logical
  cursor visible, typing/navigation visibly updating, and the preview transitioning when the
  target changes.
- The RemoteComputerPane offers only remote devices; local sessions never auto-open it and no
  "This Mac"/local entry exists in it.
- Local frames always identify and show the AgentWorkspace target window, with visible logical
  cursor/activity and no physical cursor/frontmost-app change during background work.
- Target disappearance/reopen and Dell disconnect/reconnect clear stale frames and restore only
  the current source generation; no cross-device or cross-task frame leakage.
- Known system tool/activity titles are AceVra-owned locale labels in both locales; model-authored
  titles never surface for known operations.
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
