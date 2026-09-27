# CUA lease authority

The service-side authority is the only accepted owner of foreground lease admission and terminal
state. Node-repl and UI observe records through the typed contract; they do not mutate state.
Admission is serialized: `begin_acquire` reserves a generation, `commit_acquire` publishes an
active record, and Stop/release fence stale generations. Failures leave the service fail-closed.

CUA-4 adds, without changing the lease record shape:

- the last termination `{leaseId, reason, at}` (`released`, `interrupted`, `stopped`, `paused`, or
  a Helper termination code reconciled by services);
- desktop-level admission `{paused, pausedAt}`. `pause` closes admission first, then releases an
  active lease through the Helper; `begin_acquire` refuses with `paused`. `resume` only reopens
  admission. Pause and resume are service-API only; the runtime sideband can read `admission` and
  send `report_activity`, nothing else new;
- per-session latest activity and observation (bounded, 16 sessions). Reports are best-effort
  projections and never authorize anything. A started report cannot overwrite the same call's
  completion, and an older call cannot overwrite a newer one.
