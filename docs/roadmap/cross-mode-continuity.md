# AceVra Cross‑Mode Continuity — Future Roadmap

> Status: **future feature / roadmap only**. Do not implement as part of current work.
>
> Goal: make Bot, Coding Sessions, and Multitask feel like three modes of one AceVra rather than three disconnected products.

## Product idea

**One Ace, multiple modes.**

- **Bot** knows the user, their goals, ideas, day-to-day context, and personal tools.
- **Coding Sessions** are focused workspaces for a repository/project.
- **Multitask** coordinates multiple workers for larger jobs.

Cross‑Mode Continuity lets work move cleanly between those modes without forcing the user to restate everything or copy/paste context manually.

## Core user flows

### Bot → Coding Session

Example:

> “Okay, turn this idea into a real project and start working on it.”

AceVra should:

1. extract the implementation objective
2. collect only the relevant context from the current Bot conversation / idea / goal
3. preview what context will be handed over
4. create or open a Coding Session
5. attach the source idea/project link
6. start the coding task with that focused context

### Coding Session → Multitask

Example:

> “This is getting bigger. Split it up and use Multitask.”

AceVra should:

1. summarize current implementation state
2. identify remaining work
3. create a Multitask task graph
4. carry over repo state, constraints, and relevant decisions
5. preserve a link back to the originating Coding Session

### Multitask → Coding Session

When Multitask completes, the result should flow back into the originating coding context:

- completed changes / commits
- verification results
- unresolved issues
- decisions made
- artifacts / notes

The user should be able to continue normal coding without reading an entire worker transcript.

### Work → Bot

Example:

> “Bring the result back to Ace.”

The Bot should receive a concise project-level update rather than the entire coding transcript.

Useful returned information may include:

- what changed
- important decisions
- current project state
- next steps
- blockers
- milestone completion

Do not automatically convert all coding details into personal long-term memory.

## Handoff Packet

Implement cross-mode transfer as a structured **Handoff Packet** rather than copying raw conversation history.

Suggested conceptual shape:

```json
{
  "sourceMode": "bot",
  "destinationMode": "coding",
  "objective": "Build the first Personal Bot settings surface",
  "context": ["selected relevant facts / decisions"],
  "sourceRefs": ["idea:...", "conversation:..."],
  "constraints": ["do not change current auth flow"],
  "permissions": ["repo-read", "repo-write"],
  "linkedProject": "acevra",
  "returnPolicy": "summary-and-artifacts"
}
```

Important properties:

- explicit source and destination
- minimal relevant context
- provenance / links back to source
- task objective
- constraints
- permissions/capabilities
- return expectations
- versioned/typed contract

## Privacy and context boundaries

This is critical because Bot may know substantially more personal information than a coding worker needs.

Rules:

- never dump all Bot memory into a Coding Session
- never dump full coding transcripts back into personal memory
- use least-context-required handoffs
- allow the user to inspect/edit the context being transferred
- preserve provenance so the user can see where a fact came from
- sensitive/personal context should require explicit inclusion when it is not obviously necessary

Recommended UX:

```text
Move to Coding Session

Objective
Build X

Context to carry
✓ current idea summary
✓ project constraints
✓ referenced mockup
□ unrelated personal memory

[Start Coding Session]
```

## Shared project / object graph

Longer term, modes should link through persistent objects rather than only conversations.

Potential object relationships:

```text
Goal
 └─ Project
     ├─ Idea
     ├─ Coding Session
     ├─ Multitask Run
     ├─ Decision
     └─ Artifact
```

This lets Ace answer questions like:

- “What happened with that idea I had last week?”
- “Which coding session implemented this?”
- “What is still unfinished for this goal?”
- “Take this idea and make it a real project.”

## UI direction

Keep mode switching explicit and understandable.

Useful actions:

- **Take to Work**
- **Open in Coding Session**
- **Use Multitask**
- **Bring back to Bot**
- **Link to Project**

Each destination should show provenance:

```text
Started from: Bot → Idea: Personal Bot customization
```

and allow one-click navigation back to the source.

### Handoff status

Small status cards can show cross-mode progress without exposing internal agent complexity:

```text
Ace is working on this in Coding
Open session →
```

or:

```text
Multitask completed
4 tasks done · verification passed
Review result →
```

## One identity, different behavior

The system should not pretend that every mode is a different personality.

The same top-level Ace identity can persist across modes while the runtime context changes:

- Bot persona/personal context
- coding/repo context
- Multitask coordinator/worker graph

This creates continuity without contaminating every task with every type of context.

## Suggestions vs automatic switching

Ace may suggest a handoff when it is clearly useful:

> “This looks like implementation work. Want me to open it as a Coding Session?”

But changing modes / spawning work should remain explicit and visible to the user.

## Cross-device extension later

Once DeviceService / computer execution is mature, a handoff can also include an execution target:

- Mac
- Dell
- cloud VM
- automatic eligible-device selection

Example:

> “Take this to Coding and run the long test on Dell.”

Device routing should remain a separate capability decision from the logical mode handoff.

## Failure / interruption behavior

Cross-mode work should survive interruption cleanly:

- source object remains intact
- destination session/run has its own persistent ID
- status can be resumed
- partial results can return without pretending the task fully completed
- the user can cancel destination work without deleting the source idea/goal

## Suggested implementation order

- [ ] Define stable mode/session/object IDs
- [ ] Define typed `HandoffPacket` contract
- [ ] Implement Bot → Coding Session handoff
- [ ] Implement Coding Session → Multitask handoff
- [ ] Implement Multitask → originating Coding Session return summary
- [ ] Implement Work → Bot project-summary return path
- [ ] Add context-preview / least-context controls
- [ ] Add source/backlink UI
- [ ] Add persistent Project/Idea/Goal linking
- [ ] Add interruption/resume status
- [ ] Add device-routing metadata later

## Non-goals for first version

- Do not merge all modes into one giant conversation.
- Do not silently switch modes without the user seeing it.
- Do not copy full Bot memory into coding contexts.
- Do not surface every internal worker as a personal Bot character.
- Do not create a second orchestration engine specifically for handoffs.

## Parallel development policy

When implementation begins, use a fresh feature branch/worktree from the latest good `main` and follow `docs/roadmap/parallel-development-policy.md`.

Roadmap branches are reference-only and should not be used as long-lived implementation bases.

## Guiding idea

**An idea should be able to start with Ace, become real work, fan out into multiple workers when needed, and return as useful project knowledge — without the user having to reconstruct context manually.**