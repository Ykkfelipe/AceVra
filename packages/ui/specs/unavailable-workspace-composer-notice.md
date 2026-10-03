# Unavailable local workspace composer notice

## Problem

When a restored local project's folder no longer exists, its workspace tab is marked
`availability: "unavailable-local-directory"` and the coding pane becomes read-only. Today the
composer simply disappears; the only hints are a small info icon next to the project name and a
disabled New task button. Users read the missing composer as "the input moved somewhere else".

## Product rules

- When the primary coding pane suppresses the composer **because the shell workspace's local
  folder is unavailable**, the bottom dock shows an inline notice in the composer's place. It
  never appears for any other read-only reason.
- The notice states that the project's folder cannot be found, shows the full folder path
  (monospace, wraps instead of truncating), and explains that history stays readable while new
  messages need the folder. Copy exists in en-US and zh-CN.
- Actions, in order of emphasis:
  1. **Open folder…** — the existing workspace-menu open-folder action
     (`onOpenFolderFromWorkspaceMenu`). Hidden when the shell disallows opening workspaces
     (`allowOpenWorkspace === false`, e.g. Web remote control).
  2. **Remove project** — the same removal transaction as the sidebar's project menu "Remove"
     (running-chat confirmation, close tab, release runtime, invalidate task caches). It does not
     delete task history.
- "Open folder…" opens or activates the chosen folder as a project. It does not re-point this
  project's history to a new path, and it does not re-check availability: `availability` remains
  a one-shot startup check (restore + restart, as the sidebar copy says, clears it).
- Read-only semantics are unchanged: `readOnly` still hides the composer, queue, share dock and
  edit/retry/fork actions exactly as before. Subagent/side-pane observation panes, split panes
  whose binding is `readOnly`, panes showing another workspace, remote workspaces, and the
  sidebar/header indicators behave as before (no notice).
- Layout uses the composer dock width on desktop and mobile Web; action buttons wrap on narrow
  widths. Visuals follow `DESIGN.md`: first-level rounded container (`rounded-xl`), `bg-surface`
  with `border-border` like other bottom-dock banners, warning colour only on the icon, `text-ui-*`
  typography, `role="status"` (persistent state, not an interruption).

## Ownership and interfaces

- **State owner**: the window tab store (`packages/ui/src/store/tabStore.ts`). The notice reads
  `isWorkspaceTabReadOnly(tab)` for the tab whose key (`workspaceIdentity?.trim() ||
workspacePath`) matches the shell workspace. No new state, cache or flag is introduced.
- **Removal transaction owner**: `useWorkspaceTabRemoval(tab)` in `packages/ui/src/hooks/`,
  extracted unchanged from `WorkspaceSidebarItem`. Both the sidebar menu and the notice call it;
  there is no second removal path.
- **Open folder**: the root `onOpenFolderFromWorkspaceMenu` already passed into
  `WorkspaceShellLayout` (same handler as the draft composer workspace menu).
- **Presentation**: `UnavailableWorkspaceNotice` (pure props: path, optional `onOpenFolder`,
  optional `onRemoveProject`). The live wrapper `UnavailableWorkspaceComposerNotice` resolves the
  tab and the removal hook and renders the presentation.
- **Slot**: `WorkspaceShellLayout` builds the notice only when `workspaceReadOnlyReason` is set
  (which App derives solely from `unavailable-local-directory`) and passes it as
  `readOnlyComposerNotice` through `V4WorkspaceChatArea` → `WorkbenchShellBinding` →
  `WorkbenchLeafPane`. The leaf forwards it to `SessionPane` only when the pane's read-only state
  comes from the shell workspace (`isShellWorkspace && shell.readOnly`) and not from the pane's own
  binding. `SessionPane` renders it as the bottom-dock content when `readOnly` is true; otherwise
  the slot is ignored.

```text
startup restore ──► tabStore.tab.availability = "unavailable-local-directory"   (single owner)
                         │
App: isWorkspaceReadOnly ─► workspaceReadOnlyReason ─► WorkspaceShellLayout
                                                         │ builds <UnavailableWorkspaceComposerNotice/>
                                                         ▼
          V4WorkspaceChatArea (shell.readOnlyComposerNotice) ─► WorkbenchLeafPane
                                   (forward only if isShellWorkspace && shell.readOnly && !binding.readOnly)
                                                         ▼
                      SessionPane: readOnly ? readOnlyComposerNotice : composer dock

Remove project click ─► useWorkspaceTabRemoval
   1. running chat? ─► confirm dialog (cancel = no change)
   2. tabStore.closeTab(tab.id)          (tab store picks next active tab; notice unmounts)
   3. release runtime preparation       (fire-and-forget, failure logged)
   4. invalidate task query cache scopes
   5. local only: Windows reserved-name scan toast (best effort)
```

Event order is the existing sidebar order; steps 3–5 are idempotent with respect to a tab that is
already gone. A second click after the tab closed is a no-op because the wrapper unmounts once the
tab store no longer holds the unavailable tab.

## Acceptance scenarios

1. Restore a window whose project folder was deleted. Selecting the project shows the draft empty
   state with the notice in the composer position, including the full path, "Open folder…" and
   "Remove project". No composer is rendered.
2. Selecting a historical task in that project shows its timeline with the same notice in the
   dock; edit/retry/fork stay hidden as before.
3. "Open folder…" opens the existing folder picker; choosing a different folder opens it as a
   project. Choosing nothing changes nothing.
4. "Remove project" with no running chat removes the project immediately, like the sidebar menu.
   With a running chat, the same confirmation dialog appears; cancel keeps the project.
5. Switch the UI language to 简体中文: the notice title, description and actions are Chinese, the
   path is unchanged.
6. Web remote control (`allowOpenWorkspace=false`) shows the notice without "Open folder…".
7. Subagent observation tabs, read-only split panes, panes from another workspace, and remote
   workspaces show no notice; their read-only behaviour is unchanged.
8. At ~420 px wide the notice has no horizontal overflow; the path wraps and buttons wrap.

E2E scenario (desktop): seed a persisted local workspace whose directory is removed before launch,
start the app, select the project, and assert the element with test id
`unavailable-workspace-notice` is visible inside `v4-session-pane-workspace-main`, contains the
path, and that `unavailable-workspace-notice-remove` removes the project's sidebar item.
