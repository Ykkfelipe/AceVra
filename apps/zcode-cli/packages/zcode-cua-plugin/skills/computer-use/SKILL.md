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

The compatibility bootstrap for hosts that expose the session bridge is
`scripts/computer-use-client.mjs` **at the plugin package root** — the directory that contains the
`skills/` folder this skill lives in. It is not under `skills/computer-use/`, and the plugin's
`package.json` declares it as the package `main`; import that path and nothing else. The module only
adapts the host bridge and never constructs a second runtime. If the host did not provide
`agent.computerUse`, report unavailable and stop. Never construct a second CUA runtime, launch a
Helper, open a broker socket, or synthesize native input outside this SDK.

## Exact API (read this before the first call)

Call tools by their exact names on the facade; names with a dot need bracket syntax:

```js
const cu = agent.computerUse;
const surface = await cu.describe();   // exact names, argument shapes, availability, limits
const apps = await cu.list_apps();
const state = await cu.get_app_state({ pid });                  // pid from list_apps
const tree = JSON.parse(state.content[0].text).tree;            // { elements: [...] }
await cu["computer.press"]({ semantic_ref });                   // observed button/tab/menu item
await cu["computer.set_value"]({ semantic_ref, value: "cats" }); // observed writable field
```

There is no global `computer` object, and results are MCP-shaped (`content[0].text` holds JSON;
there is no `state.text` or `state.state_id`). If a call is refused, its message states the
expected arguments; fix the call once instead of probing variants. `Object.keys(agent.computerUse)`
lists the real methods.

Two ways to call the same operation — both land on the same runtime method, and `describe()`
gives you both spellings for every entry (`name` and `mcp_tool`):

- Inside a `node_repl` cell: `agent.computerUse["computer.open_app"]({ bundle_id })`.
- As an MCP tool: the name is the same with every non-alphanumeric character replaced by `_`
  and the `mcp__computer-use__` prefix, e.g. `mcp__computer-use__computer_open_app`. Do not grep
  the runtime or plugin sources to discover call syntax; `describe()` already answers it.

Background (never takes the user's foreground): `computer.press`, `computer.set_value`,
`computer.workspace_click({ pid, target_role, target_label })`,
`computer.workspace_type_text({ pid, text, target_label? })`,
`computer.workspace_confirm({ pid, target_label? })` (press Enter inside the addressed field —
the background submit),
`computer.workspace_scroll({ pid, delta })` (delta −1…1, positive down),
`computer.open_app({ bundle_id })` (launch an app, or recreate its window when it is running
windowless).

Background limits — plan around them up front:

- **Submitting a field in the background: use `computer.workspace_confirm`.** It presses Enter
  inside the addressed text field via Accessibility and is verified by the window title changing.
  Proven dead ends on Chrome (do not retry them): setting the address bar to a search URL does not
  navigate, and the new-tab page exposes no AXPressable submit control.
- Use `semantic_ref`/`pid` only from the latest `get_app_state` of that app; older refs are refused.
- **Do not script apps** with `osascript`/AppleScript, `open`, or other shell automation for a
  Computer Use task. It bypasses the background guarantees and can steal the user's foreground.
  If a step is unsupported in the background, say so.

## Observation-first workflow

1. `list_apps()` (and `list_windows()` when the window matters) to find the target `pid`.
2. If the app is not running, or is running but `list_windows()` shows no usable window for it
   (browsers keep the process alive after the last window closes), call
   `cu["computer.open_app"]({ bundle_id })` first — it starts the app or recreates a window in the
   background. Do not fall back to desktop takeover just because a target app has no window.
3. `get_app_state({ pid })`, then pick elements by `role`/`label` from `tree.elements`.
4. One state-changing action per fresh observation. Observe again after acting; `unknown` is not
   success, and a missing `action_sent` field is not a failure.
5. Use `screenshot({ pid })` only when visual evidence is required. Emit SDK images through the
   structured SDK result; do not JSON-stringify the full result or manually emit image bytes.

## Background work and the live preview

- When you work in another app on this Mac, AceVra shows a small floating live preview of
  **that app's window** in the conversation. It is product UI that AceVra manages
  automatically: never open AceVra/ZCode menus to find, enable, or resize it, and only inspect
  AceVra's own UI when the user asks about AceVra.
- "Use this Mac in the background" / "work in Notes in the background" select the local
  background workspace: start with that app's `get_app_state` so the preview binds to it.
- Do not narrate Computer tool calls in your reasoning language as display titles. Computer
  tool-call labels are product-owned and rendered by AceVra.
- "Use my Dell" selects RemoteComputer for that named remote target. Never substitute this Mac
  when the requested computer is unavailable, or substitute Dell for a local background request.
- Create a fresh empty document before typing. Never dismiss Save/Discard/Replace dialogs for
  pre-existing user content. A delivered input with unknown application effect requires a fresh
  target observation; a newer visual frame alone is not confirmation.

## Foreground control

Foreground control is **not available to you** on this Mac: `computer.acquire_control` and every
method that needs a lease are refused. AceVra's local product rule is that the agent works only
in its own background environment — it never takes the user's screen, cursor, or keyboard. When
a step truly needs keys or the user's hands (e.g. submitting a search that has no background
submit control), say so plainly and stop; the user decides what happens next. Never claim you
have control, and never retry a refused foreground call with different arguments — the refusal is
a product boundary, not an argument error. Release/lease language in older notes is kept only for
remote (Dell) sessions, which have their own control flow.
