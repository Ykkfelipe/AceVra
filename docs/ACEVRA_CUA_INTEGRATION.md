# AceVra Computer Use identity integration note

For the Computer Use worktree integration after its current spike is complete:

- Product: `AceVra`
- Development app: `AceVra Dev`
- Reserved future helper identity: `dev.acevra.cua-helper`
- Reserved future helper development identity: `dev.acevra.cua-helper.development`
- Legacy provider OAuth callback remains `zcode://`

This note reserves naming only. It does not ask the active Computer Use worktree to restart, redo,
or rebase its spike now. The helper code, signing identity, permission behavior, bundle IDs, and
TCC state are not changed by this task. Coordinate helper identity adoption during integration,
after validating the helper's update and permission persistence requirements.
