---
name: computer-use
description: "Use when the user explicitly asks to observe or control native macOS desktop applications with Computer Use, including listing apps/windows, reading app state, taking screenshots, requesting permissions, pressing observed controls, setting observed values, or explicitly acquiring and releasing foreground control. Do not use for web-page work; prefer Browser Use. Main agent only."
---

# Computer Use

Use the shared `node_repl` Computer Use SDK only after the official
`computer-use@zcode-plugins-official` plugin is enabled. This skill does not create a Helper,
broker, lease authority, or native runtime.

Every `js` call runs in a fresh kernel. The shared `node_repl` host installs the client before
each cell, so start with the host-provided facade:

```js
const computerUse = agent.computerUse;
```

The package's `scripts/computer-use-client.mjs` is the compatibility bootstrap for hosts that expose
the session bridge; it adapts that bridge and never constructs a second runtime. If the host did
not provide `agent.computerUse`, report unavailable and stop. Never construct a second CUA runtime,
launch a Helper, open a broker socket, or synthesize native input outside this SDK.

## Observation-first workflow

1. `await computerUse.list_apps()` and `await computerUse.list_windows()` identify current targets.
2. `const state = await computerUse.get_app_state(...)`; always surface `state.text` and retain
   `state.state_id` plus element `index` values from that exact observation.
3. Prefer semantic `computer.press({ semantic_ref })` and
   `computer.set_value({ semantic_ref, value })`. Never pass raw coordinates, AX paths, PIDs,
   guessed element titles, or IDs from an earlier observation.
4. Observe again after an action. One state-changing action follows one fresh observation.
   `unknown` is not success, and a missing `action_sent` metadata field is not a failure.
5. Use screenshots only when visual evidence is required. Emit SDK images through the structured
   SDK result; do not JSON-stringify the full result or manually emit image bytes.

## Foreground control

`computer.acquire_control`, `activate_target`, pointer, click, typing, key, scroll, and drag paths
require the host-approved local desktop lease. Never use them in remote replayable/mobile or
subagent contexts. A foreground method fails when the target, geometry, focus, permissions, or lease
is stale; refresh with observations instead of retrying the same unchanged call. Release control
when the user-requested sequence is complete. The service-owned lease and signed Helper remain the
only authority; this skill cannot override them.
