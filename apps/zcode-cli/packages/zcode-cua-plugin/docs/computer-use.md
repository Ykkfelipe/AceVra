# Computer Use

Computer Use is the official, default-off desktop capability. When the
`computer-use@zcode-plugins-official` plugin is enabled, the shared `node_repl` host exposes
`agent.computerUse`; the client in this package is only a bootstrap facade. It does not start a
Helper, open a broker socket, acquire a lease, or provide an alternate native actuation path.

## Bootstrap

The shared `node_repl` host installs the Computer Use client as `agent.computerUse` before every
fresh JavaScript cell. The package's `scripts/computer-use-client.mjs` — at the plugin package root,
the directory containing the `skills/` folder, and declared as the package `main` — is the official compatibility
bootstrap for hosts that expose the session bridge; it only adapts that host bridge and never
constructs a runtime.

If `agent.computerUse` is absent, stop and report that the Computer Use plugin or native runtime is
unavailable; do not fall back to shell input, browser automation, or a second Helper.

## Safe workflow

1. Call `list_apps` and `list_windows` to identify a real target.
2. Call `get_app_state({ pid })` and use `JSON.parse(result.content[0].text).tree` (its
   `observation_id` and element `semantic_ref`s) as the observation boundary.
   `await agent.computerUse.describe()` lists every exact tool name, argument shape and limit.
3. Use only semantic methods such as `computer.press` and `computer.set_value` with an observed
   `semantic_ref`; never invent coordinates, AX paths, or raw native handles.
4. Observe again after each action. Treat `unknown` as unknown, not success.
5. Foreground methods require the host's explicit control lease and local desktop context. Never
   bypass that lease, never use remote/subagent contexts, and release control when finished.

The Helper and service-owned lease authority remain the only sources of native truth. This plugin
only supplies the official skill, documentation, and client bootstrap.
