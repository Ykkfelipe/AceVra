# Azure OpenAI in the custom fork (Phase 7)

Findings from inspecting the provider architecture, before any code was written.
Status: **implemented and verified on 2026-09-22 — configuration only, no adapter, no
runtime change.**

## Does the existing OpenAI-compatible provider suffice?

**Yes, for Azure's v1 API surface. No dedicated adapter is justified.**

The pieces that decide this:

- `providerApiTypeDataSchema` already offers `openai-chat-completions` and
  `openai-responses` alongside `anthropic-messages`
  (`packages/provider/src/config/provider-data-schema.ts`).
- `providerApiDataSchema` carries `{ type, baseUrl, headers }`, where `headers` is a free
  `Record<string,string>`. Arbitrary auth headers are therefore already expressible.
- Access is `{ type: "api-key", apiKey }`.
- `resolveModelProviderRuntimeBaseUrl` deliberately hands the runtime an **API base URL**
  and lets the SDK append `/chat/completions`, `/responses` or `/messages`
  (`packages/services/src/model-provider/legacyModelProviderSerialized.ts:591`).

So `baseUrl = https://<resource>.openai.azure.com/openai/v1` composes to
`…/openai/v1/chat/completions`, which is exactly Azure's v1 path, with the deployment name
carried in `model`. That is pure configuration.

The **legacy** Azure surface would need an adapter, and this is the deciding distinction:
`/openai/deployments/{deployment}/chat/completions?api-version=…` puts the deployment in
the path and requires a query parameter, neither of which a base-URL-plus-suffix client can
express. If a resource only exposes that shape, write a small adapter rather than trying to
bend the base URL.

Auth: Azure accepts the `api-key: <key>` header; the v1 surface also accepts
`Authorization: Bearer`. If the runtime's Bearer header is not accepted, set `api-key`
through the provider's `headers` map instead of changing runtime code.

## Model metadata is already sufficient

`completeModelPropertiesDataSchema` (`packages/shared/src/model-config.ts`) covers
`contextWindow`, `supportsToolCall`, `supportsJsonSchemaOutput`, `inputFormat` /
`outputFormat`, and `supportsMidConversationSystem`. `completeModelOptionSpecsDataSchema`
covers `maxOutputTokens` and `reasoningLevel` — the latter maps onto GPT-5-mini's reasoning
effort, so the composer's Low/High/Max control can drive it.

## Credential storage

Personal providers persist to `~/.zcode/v2/provider_config.json`, outside the repo, written
via `atomicWritePrivateTextFile`. Keys therefore cannot reach git. The fork reads endpoint,
key and deployment from `.env.azure.local`, already covered by `.gitignore`'s `.env.*.local`
rule. No key is ever committed, logged or printed.

## Verified result

Probe (no inference): `GET {resource}/openai/v1/models` returns **200** with both
`api-key` and `Authorization: Bearer`, so the v1 surface exists and no custom header is
needed. The legacy `/openai/deployments?api-version=` surface also answers 200 and lists
the `gpt-5-mini` deployment, but v1 is what is used. The Foundry `/models` inference
surface returns 404 and is not used. Note the configured endpoint was an AI Foundry
*project* URL (`…/api/projects/<project>`); the OpenAI-compatible surface lives on the
**resource root**, so the base URL is derived by stripping the project path.

Provider written to `~/.zcode/v2/provider_config.json` (mode 0600, outside the repo):

- `providerId: azure-openai`, group `standard-personal`, `api.type: openai-chat-completions`
- `baseUrl: https://<resource>.services.ai.azure.com/openai/v1`
- `personalModelIds: ["gpt-5-mini"]` — the deployment name is the model id
- properties: `contextWindow 272000`, `supportsToolCall true`, `supportsJsonSchemaOutput
  true`, `supportsImage false` (Azure publishes no vision flag, so it is not claimed)
- `reasoningLevel: { values: ["low"] }` — one level only; no GLM-style ladder invented,
  because Azure's metadata publishes no reasoning ladder. The UI consequently renders a
  fixed "Low" chip instead of a selector.
- `maxOutputTokens.map` emits `max_completion_tokens` **and deletes `max_tokens`**, since
  GPT-5 rejects the latter. Option maps are restricted-CEL JSON merge patches, so this
  parameter difference is solved in configuration rather than in an adapter.

The recorded request (`~/.zcode/cli/rollout/model-io-*.jsonl`) confirms the shape:

```
model=gpt-5-mini  stream=true  reasoning_effort=low
max_completion_tokens=128000   max_tokens ABSENT   tools=33  tool_choice set
providerId=azure-openai        durationMs=3483     querySource=main_turn
```

Azure's own response headers confirm streaming:
`content-type: text/event-stream`, `azureai-fe-is-streaming: True`.

The 33 tools sent include `Bash`, `Read`, `Edit`, `Write`, `WebFetch`, `Skill` and `Agent`
— i.e. the harness offered Azure the same tool surface it offers GLM, through the same
runtime.

### Tool-call round trip (verified 2026-09-22)

A second validation exercised an actual tool call end to end, with no code change:

| Turn | finishReason | Azure emitted | Result |
| --- | --- | --- | --- |
| 0 | `tool-calls` | `Write{file_path: …/ws/azure-tool-test.txt, content: "AZURE_TOOL_OK"}` | intercepted by ZCode's permission prompt, approved once, executed |
| 1 | `tool-calls` | `Read{file_path: …/ws/azure-tool-test.txt}` | executed; proves the Write result was returned to the model |
| 2 | `stop` | — | model reported the contents back |

The file on disk is 13 bytes, `AZURE_TOOL_OK`, no trailing newline. Only `Write` and
`Read` were used, matching the prompt's constraint. All three turns ran with
`stream=true`, 33 tools offered, `providerId=azure-openai`, `reasoning_effort=low`
(64 reasoning tokens on turn 0). A fourth, separate call is the auto-title generation:
non-streaming, zero tools.

This confirms the loop Azure -> ZCode runtime -> tool execution -> result back to Azure
runs on the existing permission and tool machinery, unmodified.

### Credential rotation

The key was rotated on 2026-09-22 after it was exposed by a harness file diff. The exposed
value was `key1` on the `obsy-resource` account (matched by hash, never printed);
`az cognitiveservices account keys regenerate --key-name key1` replaced it, and both
`.env.azure.local` and `provider_config.json` were rewritten in place at mode 0600.
Propagation is not instant: the old key still authenticated for roughly 20 seconds before
returning 401. Verify a rotation by polling rather than checking once.

## Which harness capabilities should follow automatically

The load-bearing observation: `apps/zcode-cli/packages/core/src/{tool,mcp,subagent}`
contain **no references to any provider or model identity**. Dispatch is gated purely on
declared capability in `validateRequestProperties`
(`apps/zcode-cli/packages/adapters/src/model/model.ts:155`), which checks
`supportsToolCall`, `supportsJsonSchemaOutput`, `inputFormat.supportsImage` and
`supportsPdf` — never "which provider is this".

Expected to work with no Azure-specific code, given correct declared metadata:

| Capability | Expectation | Why |
| --- | --- | --- |
| Terminal / filesystem tools | automatic | ordinary tools over the same tool-call channel; needs only `supportsToolCall: true` |
| MCP | automatic | MCP servers are surfaced as tools; the MCP layer never inspects the provider |
| Subagents | automatic | subagents re-enter the same runtime and inherit model selection |
| Skills | automatic | skills are prompt/instruction payloads, not a provider feature |
| Plugins | mostly automatic | plugin tools ride the tool channel; any plugin that hardcodes a model id is the exception |
| Browser use | automatic **if** the flow is text+tool-call; the vision path additionally needs `inputFormat.supportsImage: true` on the Azure model |

Genuine risks, all metadata rather than architecture:

- `requiresMfjsToolSchema` is a per-model tool-schema quirk. It must be set correctly for
  Azure or tool calls may be shaped wrongly.
- `reasoningLevel.values` must match what the deployment accepts, or
  `validateRequestProperties` rejects the request before it is sent.
- Declaring a capability the deployment lacks fails at request time, not at config time.

None of this requires touching MCP, plugins, subagents or the agent runtime.


## Single-value `"default"` means provider-managed effort

`gpt-5.4-nano` (and every Command Code model) declares `reasoningLevel: { values:
["default"], map: "{}" }`: exactly one nominal value and an empty merge patch. That
combination is read as **provider-managed effort** — the deployment decides, ZCode sends no
reasoning parameter at all. Concretely:

- The composer and the settings surfaces hide the thought-level control for these models
  (`isProviderManagedThoughtOption`, `packages/ui/src/lib/modelThoughtOption.ts`). Hiding
  happens at the render sites only; `resolveModelThoughtOption` keeps returning an option.
- The internal selection still carries `reasoningLevel: "default"`, so
  `validateModelSelectionOptions` and every submission path keep working unchanged.
- The empty map writes nothing: no `reasoning_effort`, no `thinking`, no `output_config`.
  Verified per-entry against the live personal config — 183/183 assertions, 60
  `["default"]` entries emitting zero reasoning paths.
- `gpt-5-mini` is *not* one of these: its ladder is a genuinely single `"low"`, so it keeps a
  fixed "Low" chip. Do not collapse the two cases into one.

Because the value is now shown outside the composer too (subagent labels, `list_models`
rows), `"default"` has a localized word ("Default" / "默认") in
`chat.toolbar.thoughtLevel.value.default`.

## gpt-5.4-nano comparison (2026-09-22)

`gpt-5-nano` is **not deployed** on this resource. The deployments are `gpt-5-mini`,
`Phi-4-mini-instruct` and `gpt-5.4-nano`. Nothing was deployed; `gpt-5.4-nano` was added to
the **existing** `azure-openai` provider — no new provider, no adapter.

Config differences from gpt-5-mini, all conservative:

- `reasoningLevel: { values: ["default"], map: "{}" }` — the patch is empty, so
  `reasoning_effort` is **never sent**. Azure publishes no reasoning metadata for this
  deployment, so none is invented. Confirmed absent from both agent-loop requests.
- `contextWindow: 128000`, `maxOutputTokens.max: 16384` — deliberately under-declared,
  since Azure publishes no limits for this deployment.
- `supportsImage: false` — no vision flag published.

### Result: task FAILED, on model behaviour, not harness compatibility

The single standardized run asked for `nano-tool-test.txt` containing exactly
`NANO_TOOL_OK`. gpt-5.4-nano instead emitted:

```
Write{file_path: .../ws/azure-tool-test.txt, content: "NANO_TOOL_OK\n"}
Read {file_path: .../ws/azure-tool-test.txt}
```

Two errors: the wrong filename — it targeted the pre-existing `azure-tool-test.txt` left by
the gpt-5-mini run — and a trailing newline the prompt excluded. The write was **denied**,
because it was not the required Write and approving it would have destroyed the gpt-5-mini
evidence. `azure-tool-test.txt` is unchanged at 13 bytes, and `nano-tool-test.txt` was never
created.

This is a capability difference, not a compatibility defect, so **the agent runtime was not
modified**. Provider, transport, streaming, tool-call encoding and permission interception
all behaved correctly.

### Behavioural differences worth noting

| | gpt-5-mini | gpt-5.4-nano |
| --- | --- | --- |
| tool-call shape | one call per turn, sequential | `Write` + `Read` emitted together in one turn |
| filename accuracy | correct | wrong — reused a file already in context |
| content accuracy | exact, no trailing newline | added a trailing newline |
| agent-loop calls | 3 | 2 (then denied) |
| agent-loop latency | 7569 ms | 6250 ms |
| reasoning tokens | 64 | 0 (no `reasoning_effort` sent) |
| prompt-cache reads | 30080 on turn 1 | 0 on turn 0, 31872 on turn 1 |

Emitting both tool calls in a single turn is legal parallel tool calling and the runtime
handled it; it simply gives the model no chance to see the first result before choosing the
second target.

Permission interception behaved **identically** for both models: the same prompt, the same
four options, the same one-time grant semantics, and Deny correctly aborted the write while
still returning the Read result to the model.


### gpt-5.4-nano retry in a clean workspace — PASSED

The first nano attempt ran in a workspace that already held `azure-tool-test.txt` from the
gpt-5-mini run, and nano wrote to that filename instead of the requested one. The retry
used a fresh, empty workspace with a neutral name (`scratch-b`, so the directory name could
not prime the model) and a collision-proof filename. **Nothing else changed**: same provider
config, same runtime, same tool implementations, `reasoning_effort` still omitted.

Result: **task completed correctly.**

- Filename: `nano-agent-proof-9271.txt` — exact.
- Content: `b'NANO_TOOL_OK'`, 12 bytes, **no trailing newline** — exact. Verified in the tool
  call before approval and again on disk by hexdump.
- Tool calls: **sequential**, not parallel. Call 0 emitted `Write` alone; call 1 emitted
  `Read` only after the Write had executed, against the *same* path; call 2 was the final
  answer. No path outside the target file was touched, and no other file was created.
- Write result was incorporated before Read — the ordering proves it, unlike the first
  attempt where both calls were emitted in the same turn before any result existed.

| | agent loop | ancillary (title) |
| --- | --- | --- |
| calls | 3 | 1 |
| latency | 8687 ms (4169 / 2935 / 1583) | 1597 ms |
| input tokens | 96015 | 263 |
| output tokens | 222 | 14 |
| reasoning tokens | 0 | 0 |
| tool calls | 2 (`Write`, `Read`) | 0 |
| streaming | true on all 3 | non-streaming |

`reasoning_effort` was absent from every request and `max_tokens` never appeared, confirming
the empty reasoning map and the GPT-5 output-parameter rewrite held.

**Interpretation.** The parallel `Write`+`Read` emission seen in the first attempt was not a
fixed trait of the model — in a clean workspace nano sequenced the calls correctly. The
original failure is better explained as context contamination: a pre-existing file in the
workspace pulled the model's filename choice toward it. The harness was never modified for
either attempt, and no compatibility defect was found in nano.
