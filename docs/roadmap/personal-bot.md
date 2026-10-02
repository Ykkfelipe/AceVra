# AceVra Personal Bot — Future Roadmap

> Status: **future feature / roadmap only**. Do not implement as part of current work.
>
> This document preserves the agreed direction for a dedicated Personal Bot section in AceVra without changing or interrupting active coding/runtime work.

## Product role

AceVra should have three distinct user-facing modes:

- **Coding Sessions** — work with AceVra on a repo/project.
- **Multitask** — explicitly split a larger objective across multiple workers.
- **Bot** — one persistent, private, personalized AceVra character for day-to-day life and tasks.

The Bot should feel like **one continuous agent identity**, not a visible team of subagents.

## Core Bot experience

The Bot is the user's general personal assistant and companion layer for:

- regular chatting
- web research
- email
- calendar
- personal goals
- ideas / brainstorming
- notes
- day-to-day planning
- personal files where permission exists
- remote computers / devices
- light background tasks
- ongoing personal context and memory

Even if helper processes are used internally, the user should experience **one Bot / one character**.

## Persistent identity / persona

The Bot should have an identity layer separate from conversation history:

- name
- avatar / character
- voice
- communication style
- visual identity
- user preferences
- relationship history
- stable personality configuration

Keep persona separate from stored personal context so the system does not rely on one giant chat transcript.

## Personal memory

Support long-term personal context that can grow over time, with user visibility and control.

Potential memory categories:

- people
- projects
- goals
- preferences
- routines
- places
- past decisions
- important events
- active situations
- recurring interests

Use relevant retrieval rather than injecting the entire memory set into every turn.

Users should be able to inspect and manage what the Bot remembers.

## Goals and ideas

Treat some user information as ongoing objects rather than one-off messages.

Examples:

- long-term goals
- projects
- ideas
- plans
- things to revisit

A voice note or conversation can optionally create/update these objects when appropriate.

The Bot should surface them only when genuinely relevant, not constantly.

## Voice notes — user to Bot

Voice notes should be a first-class interaction mode, distinct from live dictation.

Desired flow:

```text
Record naturally
  ↓
Send audio
  ↓
Transcribe / understand after recording
  ↓
Bot processes intent / ideas / tasks
```

Requirements:

- user can record without watching live transcription
- natural pauses, interruptions and corrections are okay
- keep the original audio
- generate transcript after recording
- optionally allow transcript expansion/collapse
- where supported, allow multimodal/audio-capable models to reason from audio directly rather than relying only on transcript

## Voice notes — Bot to user

The Bot should also be able to send **short** voice notes.

Good uses:

- quick updates
- reminders
- short explanations
- status summaries
- brief personal replies

Do not turn every answer into long synthetic audio.

Potential response settings:

- Text
- Voice note on request
- Auto voice for short updates
- Live voice later

## Future live voice / calls

Longer-term, add a real-time call mode:

```text
Live voice
  +
screen perception
  +
Computer Use
```

Possible interactions:

- user asks the Bot to look at a shared screen
- Bot explains what it sees
- user grants control
- Bot clicks/types/scrolls under explicit permissions

Use clear permission levels:

- **View screen** — Bot can see the shared screen
- **Assist** — Bot can point/highlight guidance
- **Control** — Bot may click/type/scroll
- **Continue independently** — Bot may keep working after explicit user approval

## Email / calendar / web / personal tools

These should feel like native Bot capabilities rather than separate personalities.

Conceptually:

```text
                 Bot
                  │
      ┌───────────┼───────────┐
      │           │           │
    Email      Calendar      Web
      │           │           │
    Files      Notes      Computers
```

Read/search operations can be lower-friction.

Consequential actions should have clear approval UX where appropriate, such as:

- sending email
- deleting or moving important data
- cancelling appointments
- submitting forms
- other externally consequential actions

## Computers / devices

Reuse AceVra's existing computer and coding-server infrastructure.

The Bot should be able to use registered machines such as:

- local Mac
- Dell over SSH
- cloud VM
- future devices

Examples:

- check if a service is running on Dell
- run a background task there
- inspect logs
- download something to the Dell rather than the Mac
- use Computer Use on an available machine when explicitly allowed

Device execution should be a shared AceVra capability, not reimplemented specifically for Bot.

## Bot self-customization / interactive space

The Bot should be able to customize **its own section and identity** through controlled app tools.

Examples:

- generate or update its avatar
- change accent colors
- change chat bubble styling
- change wallpaper/background
- choose animation presets
- change glow / idle effects
- switch voice
- change display title / descriptor
- save named appearance presets / looks

Example natural-language requests:

- “Make yourself more futuristic.”
- “Use a blue-neon look.”
- “Make the chat background calmer.”
- “Change your avatar to something more robotic.”
- “Use a warmer style at night.”

### Safe implementation model

Do **not** let the Bot arbitrarily rewrite app UI code.

Expose controlled customization tools / structured settings, for example:

- `generate_avatar`
- `set_bot_theme`
- `set_chat_wallpaper`
- `set_accent_color`
- `set_idle_animation`
- `set_voice`
- `update_bot_profile`

Prefer **Preview → Approve → Apply** for visual changes.

Later, harmless cosmetic Bot-section changes could optionally be auto-applied if the user enables that behavior.

## Bot 'space' / room concept

The Bot section can feel like the Bot's own personal space rather than a generic chat window.

Possible sections:

- Chat
- Memory
- Goals
- Ideas
- Today
- Appearance

The visual language should remain consistent with AceVra, but the Bot area can feel more personal and expressive than coding workspaces.

## Appearance presets / looks

Support reusable visual identities such as:

- Default
- Futuristic
- Minimal
- Cozy
- Night
- Experimental

The user or Bot can switch between them conversationally.

## Dynamic appearance later

Possible later enhancements:

- animated avatar states
- subtle mood/expression states
- time-of-day themes
- dynamic backgrounds
- lightweight home widgets
- live 2D/3D avatar
- voice-synced expression

Default behavior should stay stable and calm. Avoid constant unsolicited visual changes.

## App-level integration later

Deeper control over the entire AceVra app can be explored later, but should be more restricted than Bot-section customization.

Potential later scope:

- global accent/theme
- notifications
- broader layout preferences
- global settings

Keep these behind explicit permissions / confirmation.

## Shared architecture

Do not build a separate engine for Bot capabilities.

Desired high-level architecture:

```text
                    ACEVRA CORE
                         │
                   AgentRuntime
                         │
        ┌────────────────┼────────────────┐
        │                │                │
    Coding Chat       Multitask          Bot
        │                │                │
     repo ctx       worker graph     personal ctx
     coding tools    subagents       memory/persona
        │                │                │
        └────────────────┼────────────────┘
                         │
                 Capability Runtime
                         │
       ┌─────────┬───────┼───────┬─────────┐
       │         │       │       │         │
      Web      Email   Calendar Files   Computer
                                         │
                                   Mac / Dell / VM
```

The Bot-specific layer is primarily:

```text
Bot
 ├─ identity / persona
 ├─ personal memory
 ├─ personal context retrieval
 ├─ goals / ideas
 ├─ voice interaction
 └─ access to shared AceVra capabilities
```

## Privacy / permission principles

The Bot is intended to be personal and private.

Design around:

- clear capability permissions
- explicit control for consequential actions
- user visibility into memory
- user control over connected accounts/devices
- minimal required context per task
- no hidden global app modifications

## Suggested implementation order

- [ ] Define Bot section / persistent Bot identity
- [ ] Add personal-memory model + retrieval boundaries
- [ ] Add native web / connected-tool capability access
- [ ] Add device registry integration (Mac / Dell / VM)
- [ ] Add user voice notes with post-recording transcription
- [ ] Add Bot short voice-note replies
- [ ] Add goals / ideas surfaces
- [ ] Add controlled avatar generation + Bot appearance tools
- [ ] Add preview/apply customization flow
- [ ] Add polished Bot home / 'space' UI
- [ ] Add live voice
- [ ] Add screen sharing / visual understanding
- [ ] Add permissioned live Computer Use
- [ ] Explore deeper app-wide customization later

## Non-goals for first version

- Do not expose a visible team of subagents in Bot.
- Do not make Bot another coding-session UI.
- Do not rebuild email/calendar/web/computer integrations separately for Bot.
- Do not allow arbitrary self-editing of AceVra's source/UI.
- Do not make long generated voice responses the default.
- Do not enable deep system/app control without explicit permissions.

## Guiding product idea

**Sessions are where AceVra works on projects.**

**Multitask is how AceVra coordinates multiple workers.**

**Bot is the AceVra that knows and helps the user.**