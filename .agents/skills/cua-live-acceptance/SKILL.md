---
name: cua-live-acceptance
description: "Use when running or repairing LIVE Computer Workspace acceptance against the installed AceVra alpha: WorkspaceFixture runs, zero-steal proof, mini-panel / safety-bar probes, transcript extraction, evidence capture. Production code stays untouched unless an explicit task deck authorizes a change."
---

# CUA live acceptance playbook (installed packaged app)

Everything here targets the INSTALLED candidate at `/Applications/AceVra.app`
(product name "AceVra Local Engineering Alpha"), driven through Playwright
`_electron` + the model's own node_repl cells. Existing harnesses live in
`.spike/perception/` (untracked, never commit): `m3-acceptance.mjs`,
`m2a-acceptance.mjs`, `cua-race-probe.mjs`, `m3b-live.mjs`. Copy and adapt them
rather than writing from scratch.

## 0. Non-negotiable rules

- Single app instance: `osascript -e 'quit app "AceVra"'`, then verify
  `pgrep -fl '/Applications/AceVra.app/Contents/MacOS'` is empty. A leftover
  instance makes `electron.launch` fail ("process did exit").
- Zero-steal stimulus for yield tests is FELIPE'S REAL INPUT via AskUserQuestion.
  NEVER cliclick / AppleScript / System Events / CGEvent / synthetic injection.
- No production code changes unless the task deck explicitly authorizes them;
  on a genuine product defect: STOP and report.
- `.spike/` stays untracked. No merge. No tag. Push only when the deck says so.

## 0.5 Dev app (`pnpm dev:desktop`) lifecycle — read before restarting anything

Measured 2026-10-02 (do not repeat):

- Your own chat may be running INSIDE AceVra Dev. NEVER `pkill -f` on `desktop-dev`,
  `AceVra Dev.app`, `Electron Helper` or `AceVra Computer Use`: those patterns kill the window's
  renderer/GPU/network helpers but miss Main (title `AceVra Dev`) and the Local Host
  (`zcode-host-local-1`), leaving a headless app whose sessions keep running. Killing
  `dev-desktop-env` orphans Electron; the host then crashed on stdout EPIPE (now guarded).
- Stop: `osascript -e 'quit app "AceVra Dev"'`, wait for Main to exit, then `kill -INT` the PID of
  the `pnpm dev:desktop` you started. Never start a second `pnpm dev:desktop` while one runs: the
  new instance exits on the single-instance lock and the OLD processes keep running old code.
- Freshness before ANY live run (stale processes made a whole night of probes meaningless):
  every `zcode-cli` and `zcode-node-repl-mcp` process must have started after the last rebuild of
  `packages/desktop/bundled-agents/<platform>/glm/zcode.cjs` and
  `apps/zcode-cli/packages/node-repl-host/dist/mcp/server.js`
  (`ps -o lstart= -p <pid>` vs `stat -f %Sm <file>`), and the seeded
  `$ZCODE_HOME/cli/plugins/cache/zcode-plugins-official/node-repl-host/<ver>/dist/mcp/server.js`
  must hash-equal the repo dist (`shasum -a 256`). A foreign hash means another app re-seeded it.
- Swift Helper changes need a rebuild of the signed dev Helper with the dev app QUIT first:
  `node packages/zcode-cua/native/cua-helper/build-dev-helper.mjs --arch arm64` (the default
  universal build fails to link x86_64 here). The designated requirement is stable, so TCC grants
  survive. Verify the running Helper's `cd_hash` in a `helper_identity` result afterwards.
- "Window gone but task still running / not in the Dock": check `lsappinfo info -only
ApplicationType -app <main pid>`. `UIElement` means something called `app.dock.hide()` (Electron
  does so for `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true })` without
  `skipTransformProcessType: true`); it is a product bug, not a test artifact.
- Data root: dev defaults to `~/.zcode-acevra-dev` (scripts/specs/dev-desktop-environment.md
  "Isolated data root"). If logs show `~/.zcode`, an installed ZCode.app shares and clobbers it.

## 1. Harness skeleton (proven)

```js
import { _electron as electron } from "playwright-core";
const app = await electron.launch({
  executablePath: "/Applications/AceVra.app/Contents/MacOS/AceVra",
  args: ["/Applications/AceVra.app", "--no-sandbox"],
  env: { ...process.env },
});
const page = await app.firstWindow();
await page
  .locator('html[data-desktop-business-ready="true"]')
  .waitFor({ state: "attached", timeout: 120_000 });
await sleep(12_000); // composer/turn plumbing settle
// If a "choose model" trigger is visible: click it, pick the first ENABLED option.
```

- Cells go through the MODEL, never a debug RPC: click the last visible
  `[contenteditable="true"]`, `page.keyboard.insertText` the prompt
  `"Run exactly ONE node_repl js cell containing exactly this code and change nothing:\n<cell>\nThen report the returned string verbatim."`,
  press Enter, then poll the transcript DB for the case record.
- Preamble pattern (facade is a FLAT Proxy — property name = tool name):

```js
const CU =
  globalThis.agent && typeof globalThis.agent.computerUse === "object"
    ? globalThis.agent.computerUse
    : null;
const un = (r) => {
  /* join content[].text, JSON.parse */
};
```

Calls: `await CU.list_apps({})`, `await CU.get_app_state({pid, include_image:true, include_tree:true})`,
`await CU["computer.workspace_click"]({ pid, target_role:"AXButton", target_label:"Increment" })`,
`await CU["computer.workspace_type_text"]({ pid, text })`.

## 2. Transcript extraction (WAL-aware, ghost-proof)

```js
const DB = join(homedir(), ".zcode-local-engineering-alpha/.zcode/v2/tasks-index.sqlite");
copyFileSync(DB, tmp);
copyFileSync(DB + "-wal", tmp + "-wal");
copyFileSync(DB + "-shm", tmp + "-shm");
execFileSync("sqlite3", [
  "-json",
  tmp,
  `SELECT searchable_text AS t FROM tasks WHERE t LIKE '%{"case":"${id}%"' ORDER BY rowid DESC LIMIT 2`,
]);
// balanced-brace scan from LAST index of `{"case":"<id>"`, JSON.parse that slice
```

- Case ids MUST be unique per run (append a run nonce, e.g. `m3a-x7f2k`) — reused
  ids match ghost records from old sessions.
- Escape discipline: cells embedded in harness template literals need `\\n`
  (double backslash). A raw newline inside a cell string literal makes the model
  answer "Invalid or unexpected token" and refuse to run the verbatim cell.
- Poll ~every 2.5–4 s; a model turn can take minutes. Widen thrown-error capture
  to ~700 chars with `code=` prefix (truncated errors hide refusal codes).

## 3. Zero-steal measurement (independent, automatic)

- `/tmp/invprobe` prints `{"frontmost":{bundleId,name,pid},"cursor":{x,y},"windows":[…]}`.
  It is a dev binary in /tmp — if missing, restore/rebuild it before acceptance
  (see `.spike/perception/frontmost-timeline.mjs` for the usage shape).
- Poller: `spawn("/bin/zsh", ["-c", "while true; do /tmp/invprobe 2>/dev/null | tr -d '\\n'; echo; sleep 0.3; done"])`
  → timeline of {front, pid, cursor}.
- Precondition: `open -a WorkspaceFixture` ONCE, then bring AceVra to front
  (`open -a /Applications/AceVra.app`); NOTHING in the harness touches focus while
  the agent acts. PASS = frontmost pid identical before/after AND cursor within
  0.5pt AND the frontmost timeline contains only expected apps.
- Noise sources: **Preview** steals focus (quit it: `pkill -x Preview`); a stale
  fixture instance causes `target_lost` refusals (restart fixture, retry once);
  "System Settings" appearing mid-run = external interference, rerun.

## 4. Controlled fixture

`.spike/perception/fixture/WorkspaceFixture.app` (bundle `dev.acevra.workspace-fixture`):
AXButton "Increment" + counter label, text field + echo label. Fresh installs need
`open -a WorkspaceFixture` once so LaunchServices registers it (it must appear in
`list_apps`). Counter/echo text is the state-change assertion
(`count: N`, echoed typed text).

## 5. UI probes (mini panel + safety bar)

```js
const bar = await page.locator('[data-testid="v4-computer-use-bar"]').count(); // must be 0 during background work
const panel = page.locator('[data-testid="v4-mini-computer"]').first();
// attrs: data-mini-computer-state, data-mini-computer-expanded
// children: -frame (data-frame-id), -cursor, -caption, -mode, -close, -expand, -pause, -stop, -reopen
```

- Standard sequence: observe → click → type against the fixture while AceVra is
  frontmost; assert panel visible, frame id changes across observations, cursor
  overlay present, caption truthful, `bar === 0` at EVERY sample.
- Mid-flight ×: close while running → panel gone, chip
  `[data-testid="v4-mini-computer-reopen"]` = "Working in background · Show
  Computer", task still completes; chip click restores the SAME frame id; expand
  keeps the same frame id and `data-mini-computer-expanded="true"`.
- Safety-bar proof (deterministic, no live lease needed): the render tests in
  `packages/ui/test/cuaSessionBar.test.ts` + `miniComputerPanel.test.ts` pin the
  suppression truth table; live lease runs only when a deck demands them.
- In expanded mode there are TWO `-expand` buttons; target the one inside
  `[data-mini-computer-expanded="true"]` (`.first()` grabs the occluded one and
  the click times out).

## 6. Evidence

Screenshots per phase into `.spike/perception/evidence/<run-id>/`
(panel initial / mid-flight closed / reopen / expanded / final). Console lines:
`BEFORE/AFTER` invprobe JSON, `ACTIONS` record, `ZERO_STEAL_PROBE: PASS|FAIL`,
`FRONTMOST_SEEN_DURING` array. Report format: numbered PASS list per deck §.

## 7. Known-good baselines (do not reopen)

Notes `set_value`/`type_text` AX refusal = honest Helper refusal (the agent may
legitimately fall back to Notes' scripting interface — that is a PASS, foreground
untouched). `get_app_state` observation ids are uppercase UUIDs; the foreground-
geometry registry id is lowercase — do not "normalize" either. Acceptance evidence
under `.spike/perception/evidence/` is accepted-test material: never delete.
