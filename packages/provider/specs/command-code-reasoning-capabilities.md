# Command Code verified reasoning capabilities

Status: **verified public transport, implementation approved 2026-09-22.**

## Product rule

The Command Code GOAT integration exposes an effort selector only for the 29 models in the
reviewed capability manifest. Each model keeps the exact ladder published by the installed
Command Code CLI. All other Command Code models keep their existing `['default']` / `{}`
provider-managed configuration and therefore remain hidden by `isProviderManagedThoughtOption`.

## Ownership and boundary

`packages/provider/src/command-code-reasoning-capabilities.ts` owns the reviewed catalogue and
the shared request map. The synchronizer is the sole writer for this metadata in the user-scoped
`provider_config.json`; it updates only exact `command-code` model rules already present in that
configuration. It does not create models, alter provider credentials, or touch another provider.

```
reviewed manifest -> synchronizer -> personal provider model rules -> resolver -> composer
```

The resolver remains the source of the effective option value. The UI retains its existing rule:
only exactly `['default']` is provider-managed; every verified multi-level model consequently
uses the existing selector without bespoke UI state.

## Request contract

Every manifest entry uses the same verified OpenAI-compatible patch:

```json
{ "reasoning_effort": "<reasoningLevel>" }
```

The map was accepted by the public Command Code Provider API for GPT-5.6 Luna, GLM-5.3 Flash,
and Gemini 3.8 Flash. No vendor-native thinking or output configuration fields are emitted.

## Invariants and failure behavior

- The manifest contains exactly 29 approved model IDs, without wildcard matching.
- A sync fails before writing if the provider or an approved model rule is absent.
- Existing `properties`, max-token maps, non-approved Command Code rules, and every non-Command
  Code provider are preserved unchanged.
- The synchronizer is idempotent: a second run produces no content change.
- No network or model inference is performed by the synchronizer or tests.
