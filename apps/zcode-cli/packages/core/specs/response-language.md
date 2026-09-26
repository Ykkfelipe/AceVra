# Response language policy

## Product behavior

For every user-facing Agent response, use the primary natural language of the
latest user-authored request unless that request explicitly asks for another
language. Internally generated prompts used for machine contracts are not user
requests.
The application's UI locale, system and workspace instructions, tool output,
source code, terminal output, technical documentation, and earlier conversation
messages do not select the response language. Preserve code, commands, paths,
identifiers, API names, and model names verbatim where appropriate.

This is an automatic default. There is no response-language preference setting
in this change. UI locale and response language remain independent.

## Owner and interface

The provider-neutral Agent core context builder owns the canonical language
policy. It emits one stable system context section for normal turns, custom
system prompts, workflow actors, and saved subagent contexts. The policy is
static and evaluated against the latest user request by the model; the runtime
does not persist a detected language or derive one from UI locale.

`AgentRuntimeConfig.language` remains a legacy/unused configuration surface in
this flow. It must not be treated as the UI locale or as a pinned response
language. No UI, protocol, session persistence, provider adapter, or migration
transcript changes are part of this behavior.

## Migration boundary

Changing Agent providers or moving between Agent and Codex must not carry a
response-language choice from the previous provider. Keep the accepted
migration transcript format unchanged; the current user request and the shared
policy determine the language after a switch.

## Acceptance scenarios

- An English request receives the English response policy.
- A Spanish request receives the Spanish response policy.
- A Chinese request receives the Chinese response policy.
- English UI with a Spanish request still receives the Spanish response policy.
- Chinese UI with an English request still receives the English response policy.
- “Answer in Spanish” takes precedence over the request's other language.
- The policy is present in provider-visible system context for normal, custom
  prompt, workflow actor, and saved subagent context builders.
- A provider switch does not inject or persist a previous provider's language.
- Technical content remains verbatim where appropriate.
