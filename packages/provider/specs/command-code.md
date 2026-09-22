# Command Code as a fork provider (Phase 8)

Status: **implemented and verified 2026-09-22 — configuration only, no adapter, no runtime
change.**

## What "GOAT" is

GOAT is a Command Code **subscription plan**, not a model. The docs price deals as
"$60 GOAT ($40), $70 Pro ($50)". No model named GOAT exists in the catalogue; the local CLI
lists 72 and the Provider API returns 76, none called GOAT. This matters because API access
is plan-gated: the docs state "Every plan except the Go plan has API access — GOAT, Pro,
Max, Team, and Provider". The GOAT plan therefore qualifies.

## Provider API (documented, not reverse-engineered)

From https://commandcode.ai/docs/provider:

| Endpoint | Format |
| --- | --- |
| `POST https://api.commandcode.ai/provider/v1/chat/completions` | OpenAI Chat Completions |
| `POST .../provider/v1/responses` | OpenAI Responses |
| `POST .../provider/v1/messages` | Anthropic Messages |
| `GET  .../provider/v1/models` | model list |

Auth is `Authorization: Bearer <CMD_API_KEY>`, and the docs state "The same key
authenticates the CLI and the API" — so the key already present in
`~/.commandcode/auth.json` works without issuing a new one.

Because ZCode hands the runtime a base URL and lets the SDK append the suffix, this is the
same configuration-only path used for Azure: `baseUrl = https://api.commandcode.ai/provider/v1`.

## Endpoint split matters when choosing models

`GET /provider/v1/models` returns `supported_endpoints` per model. Of 76 models, **68
support `/chat/completions` and 8 are `/messages`-only** — the whole Claude family is
`/messages`-only. A single ZCode provider carries one `api.type`, so the
`openai-chat-completions` provider configured here can only serve the 68. Serving Command
Code's Claude models would need a **second** provider entry with `anthropic-messages`
against the same base URL. That is deliberately not done yet.

## Configuration

Provider `command-code`, group `standard-personal`, `openai-chat-completions`, api-key
access. Models added (context windows taken from the API's `context_length`, not guessed):

- `deepseek/deepseek-v4-flash` — 1,000,000
- `z-ai/glm-5.3-flash` — 1,048,576

Conservative metadata, consistent with the Azure work:

- `supportsToolCall: true` — documented: "Tool arrays pass through as you send them".
- `supportsImage: false` — the models endpoint exposes no vision flag, so none is claimed,
  even though the CLI's own catalogue labels some models "vision".
- `reasoningLevel: { values: ["default"], map: "{}" }` — no reasoning ladder published, so
  `reasoning_effort` is never sent.
- `maxOutputTokens.map` emits plain `max_tokens`; these two models are not GPT-5 family and
  do not need the `max_completion_tokens` rewrite Azure required.

More on the reasoning line above: a single-value `"default"` ladder plus `map: "{}"` means
**provider-managed effort**. The composer and settings controls are hidden for those models
(they would otherwise show a meaningless one-item "default" selector), the internal selection
still carries `reasoningLevel: "default"`, and the empty patch sends nothing — no
`reasoning_effort`, no `thinking`, no `output_config`. All 60 `["default"]` entries in the
personal config were audited for this (183/183 assertions). Models with a real ladder keep
their control, and a genuinely single-`"low"` model (Azure `gpt-5-mini`) keeps its fixed
"Low" chip.

## Credential handling

The key is read **read-only** from `~/.commandcode/auth.json` and copied into
`~/.zcode/v2/provider_config.json` (mode 0600, outside the repo). The source file was
verified unmodified afterwards: mtime still 2026-09-20 18:01:35, mode 0600, all five keys
(`apiKey`, `userId`, `userName`, `keyName`, `authenticatedAt`) intact. Command Code's own
login is untouched. A dedicated Studio key can be swapped in later without code changes.

## Verification

Registry went from `providerCount: 3` to `4`. The picker lists Z.ai (GLM-5.3,
GLM-5.3-Flash), Azure OpenAI (gpt-5-mini, gpt-5.4-nano) and Command Code
(deepseek/deepseek-v4-flash, z-ai/glm-5.3-flash).

One minimal inference returned `COMMANDCODE_OK` in 2s. Recorded IO:

```
providerId=command-code  model=deepseek/deepseek-v4-flash  main_turn 1846ms
stream=true  content-type: text/event-stream  tools=33
max_tokens=16384  reasoning_effort ABSENT  finish=stop  in=36883 out=5
```

Title generation is recorded separately as `querySource=session_title`: 1977ms,
non-streaming, zero tools.
