# Azure OpenAI in the custom fork (Phase 7)

Findings from inspecting the provider architecture, before any code was written.
Status: **investigation complete, implementation blocked on credentials.**

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
