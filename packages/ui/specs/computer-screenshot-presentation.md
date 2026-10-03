# Requested Computer screenshots

The signed Helper and CUA runtime own capture and image delivery. The CLI owns the
bounded `node_repl_images` tool display in the conversation row. UI derives its
presentation from that existing display; it does not capture, persist another
image, or infer success from model prose.

## Delivery classes

Every Computer `screenshot` the runtime delivers carries the host-recorded flag
`requested_by_user` (set from the cell's `for_user: true` argument; the model
cannot write it). This yields two classes:

- **Requested** (`requested_by_user === true`): the user asked to see the screen.
  The image enters the run output and the bounded display `images`; when the
  tool row carries host-recorded `cuaOperation` and nonempty display images,
  render those images visibly after the assistant response, outside both the
  work-history disclosure and the tool-details disclosure. Retain the original
  tool row in history for execution details, but do not duplicate its images
  when the details are opened.
- **Observation** (no flag or false): the agent captured the screen for its own
  knowledge. The image still reaches the model (it is the agent's eyes), but it
  must not appear as a full picture in the conversation flow. It travels in a
  separate bounded display field `observationImages` (at most 1 image, same
  per-image byte bound); the tool-details disclosure renders it as a small
  thumbnail, and the inline after-response gallery never renders it.

Use the existing thumbnail/preview controls for both classes. Desktop
continuous events and Web replay/cold snapshots use the same persisted display
and presentation. The readonly share view follows the same rule.

```mermaid
sequenceDiagram
  participant Helper
  participant Runtime
  participant CLI
  participant UI
  Helper->>Runtime: screenshot bytes
  Runtime->>Runtime: mark requested_by_user from cell args
  Runtime->>CLI: requested → run output images; observation → model-only images
  CLI->>UI: bounded tool display (live or snapshot)
  UI->>UI: requested → visible result gallery; observation → details thumbnail only
```

Acceptance: a completed turn with collapsed history still contains the requested
image thumbnail; opening history/details produces no duplicate image. A cold
snapshot and readonly share render the same image. Observation screenshots
produce no gallery — only a thumbnail inside the step details, on live events,
cold snapshots and the readonly share alike. Reference-only observations,
refusals, and model text without delivered images produce no gallery. Automatic
Browser turn-end screenshots retain their existing placement.
