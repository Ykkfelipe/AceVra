# CUA lease authority

The service-side authority is the only accepted owner of foreground lease admission and terminal
state. Node-repl and UI observe records through the typed contract; they do not mutate state.
Admission is serialized: `begin_acquire` reserves a generation, `commit_acquire` publishes an
active record, and Stop/release fence stale generations. Failures leave the service fail-closed.
