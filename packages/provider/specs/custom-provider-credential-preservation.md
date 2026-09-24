# Custom provider credential preservation

## Product rule

A saved custom provider may be edited from a sanitized Settings view. The view reports whether
the credential is configured but never returns the secret. Saving a name, URL, format, enabled
state, or model membership must preserve the Host's existing API key and private API headers.
An explicitly supplied key or headers replaces the stored value; an explicitly empty key or
header collection clears it. A key alone does not make a provider available in chat: at least
one enabled, valid model must also be configured.

## Owner and boundary

`ProviderConfigService` owns the personal provider record and performs the preservation in its
atomic repository update. Renderer forms submit only edited public fields and explicit credential
changes. A sanitized `ProviderSettingsView` must never become the new source of secret truth.
The provider registry remains the sole source of selectable models for the Agent chat engine.

```mermaid
sequenceDiagram
  participant U as Settings form
  participant S as Provider settings service
  participant P as Personal provider repository
  U->>S: save overlay with public edits and optional credential change
  S->>P: atomic update
  P-->>S: current provider record including private fields
  S->>S: retain omitted private fields; apply explicit replacements
  S->>P: write merged provider record
  P-->>U: sanitized settings view and registry revision
```

## Acceptance scenarios

1. Save an API key, then edit the URL or name from the sanitized Settings view. The stored key
   remains configured and the provider stays eligible when its model configuration is valid.
2. Submit a different key; the new key replaces the old one. Submit an explicitly empty key;
   the credential becomes missing.
3. A provider with a saved key but no enabled valid model remains absent from the chat model
   picker and Settings clearly explains the missing model step.
4. A provider with omitted private headers retains them on a public-field edit; explicit
   headers replace them.
