import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeProviderConfigForClient, type ProviderConfigObject } from "../src/index.js";

test("client provider projections omit API keys and all API header values", () => {
  const sentinel = "FAKE_PROVIDER_SECRET_SENTINEL_DO_NOT_LEAK";
  const safe = sanitizeProviderConfigForClient({
    group: "standard-personal",
    access: { type: "api-key", apiKey: sentinel },
    api: {
      type: "openai-chat-completions",
      baseUrl: "https://provider.example/v1",
      headers: { Authorization: `Bearer ${sentinel}`, "x-api-key": sentinel },
    },
  } as ProviderConfigObject);

  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes(sentinel), false);
  assert.equal("apiKey" in (safe.access ?? {}), false);
  assert.equal("headers" in (safe.api ?? {}), false);
  assert.equal(safe.api?.baseUrl, "https://provider.example/v1");
});
