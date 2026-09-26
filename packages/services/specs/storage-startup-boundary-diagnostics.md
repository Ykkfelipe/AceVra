# Storage startup boundary diagnostics

## Scope

This temporary diagnostic candidate measures the worker startup notification from process creation through `ZCodeStorageStartupGate.accept`. It does not change startup admission, frame buffering, timeout duration, SQLite handling, import behavior, or storage ownership.

## Ownership and event order

- `ZCodeAgentProcessManager` owns the worker record and records the PID, workspace key/path, monotonic spawn time, transport/client construction times, and whether startup is required.
- `ZCodeStdioTransport` owns stdout framing and records only startup notification metadata: chunk/frame timing, JSON and protocol-schema outcomes, method, and dispatch/listener status.
- `ZCodeProtocolClient` owns protocol delivery to the startup gate and records the gate state before and after acceptance.
- `ZCodeStorageStartupGate` remains the sole owner of accepted storage startup state and reports safe schema rejection metadata.

```text
spawn → transport stdout listener → protocol client message subscription
      → stdout chunk → complete LF frame → JSON/protocol parse → emitter dispatch
      → client handleMessage → storageStartup.accept → gate state
```

All diagnostic times are monotonic milliseconds from the local process clock. Logs must not contain raw frames, params, prompts, environment contents, auth data, or provider secrets. The only notification payload values permitted are the startup phase, sequence, and error code, plus safe schema issue paths/types.

## Acceptance and failure semantics

- Existing protocol validation and dispatch behavior remains unchanged.
- A frame emitted before a protocol client subscribes is measured as undispatched to that client; no buffering behavior is added.
- Gate diagnostics distinguish invalid storage state, pre-existing terminal error, and accepted phase.
- Tests cover delivery after subscription, emission before subscription, invalid gate schema, and valid delivery after terminal state.

## Removal boundary

Remove this spec and its diagnostics after one packaged reproduction identifies the first broken boundary. Any production behavior change requires a separate spec and review after the evidence is classified.
