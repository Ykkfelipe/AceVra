import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemoteProviderSettingsCredentialGuard,
  createRendererCredentialDeniedService,
  type IProviderSettingsService,
} from "../src/index.js";

test("renderer credential RPC never reads, writes, or deletes host credentials", async () => {
  const credentialService = createRendererCredentialDeniedService();
  await assert.rejects(credentialService.load("provider:test"), /host-only/);
  await assert.rejects(credentialService.save("provider:test", "FAKE_SENTINEL"), /host-only/);
  await assert.rejects(credentialService.delete("provider:test"), /host-only/);
});

test("remote provider settings reject secret writes but allow metadata-only saves", async () => {
  const writes: unknown[] = [];
  const service = {
    savePersonalProviderOverlay: async (...args: unknown[]) => {
      writes.push(args);
      return {};
    },
    createPersonalProvider: async (...args: unknown[]) => {
      writes.push(args);
      return {};
    },
  } as unknown as IProviderSettingsService;
  const remote = createRemoteProviderSettingsCredentialGuard(service);
  const sentinel = "FAKE_PROVIDER_SECRET_SENTINEL";

  await assert.rejects(
    remote.savePersonalProviderOverlay("provider:test", {
      access: { type: "api-key", apiKey: sentinel },
    }),
    /local desktop app/,
  );
  await assert.rejects(
    remote.savePersonalProviderOverlay("provider:test", {
      api: { type: "openai-chat-completions", headers: { Authorization: sentinel } },
    }),
    /local desktop app/,
  );
  await assert.rejects(
    remote.savePersonalProviderOverlay("provider:test", {
      access: { type: "api-key", apiKey: "" },
    }),
    /local desktop app/,
  );
  await assert.rejects(
    remote.savePersonalProviderOverlay("provider:test", {
      api: { type: "openai-chat-completions", headers: { Authorization: "" } },
    }),
    /local desktop app/,
  );
  await remote.savePersonalProviderOverlay("provider:test", {
    api: { type: "openai-chat-completions", baseUrl: "https://provider.example/v1" },
  });
  assert.equal(writes.length, 1);
});
