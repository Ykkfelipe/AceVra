# Conversation work status header

## Rule

A turn work segment with a `workStatus` shows one status line above its assistant flow:
"Worked for {duration}", "Working for {duration}", "Worked", or "Stopped".

The line is an expand/collapse control only when the segment has collapsible assistant
history (`assistantHistoryRows.length > 0`). Without collapsible history it is a plain,
non-interactive label with the same text and placement: no button, no chevron, no history
trigger test id. The label keeps the truthful duration; nothing is synthesized to fill an
expander, and hidden reasoning is never exposed.

## Why

`workStatus` answers "did this turn do work and for how long"; `assistantHistoryRows`
answers "is there folded work to reveal". The header previously used only the first, so
turns whose visible text is the whole response (native text-only replies, and imported
Codex/Claude turns whose visible segments are exempt from folding) offered an expander that
opened to nothing.

## Owners and scope

- `buildConversationTurnWorkSegments` (`packages/ui/src/v4/conversationTurnWorkSegments.ts`)
  owns the segment facts; `isConversationWorkSegmentExpandable` is the single predicate.
- `ConversationTurnGroup` (live timeline, shared by desktop and mobile Web) renders the
  expander or the plain label from that predicate.
- `ConversationShareReadonlyTimeline` (share view) already renders its status line only when
  collapsible history exists, so it never showed an empty expander; it is unchanged.
- No change to which rows fold, default-open rules, durations, projection or persistence.

## Acceptance

- Imported turn with a duration and no folded rows: status text shown, no expander.
- Turn with folded tool/reasoning/intermediate-text rows: existing expander, chevron and
  default-open behavior unchanged.
- Running and interrupted labels are unchanged.
