# @zcode/zcode-cua

Computer Use runtime and broker contracts for observation and bounded semantic macOS actions.
The signed Helper owns Accessibility observation references and AX mutations. The host relays
requests only through the existing per-launch authenticated, peer-bound session.

The model-facing runtime supports observation plus `computer.press` and `computer.set_value`.
These are best-effort background actions: results include pre/post evidence and report confirmed
only when the requested state is observable and foreground, focused-window, and cursor invariants
remain unchanged. Accessibility permission is required for AX observation and mutation;
Screen Recording is required only when a screenshot is requested.

Coordinate mouse input, keyboard synthesis, app activation, and legacy unauthenticated actuation
remain unavailable. See [the Computer Use spec](specs/computer-use.md) for expiry, refusal, and
security contracts.

License: Apache-2.0.
