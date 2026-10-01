import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createAceVraSetupService } from "../../src/onboarding/acevraSetupService.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "../../src/model-provider/providerFacadeServices.js";

for (const label of ["OpenAI", "Anthropic", "compatible", "Z.ai"]) {
  test(`${label} registry models allow startup without a family`, async () => {
    const service = createAceVraSetupService({
      statePath: "/tmp/unused-acevra-state",
      models: {
        getView: async () => ({ revision: 1, providers: [{ providerId: label, models: [{}] }] }),
      } as unknown as IModelSelectionService,
      providers: {} as IProviderSettingsService,
      saveDefault: async () => {},
      readLegacyFamily: async () => {
        throw new Error("Legacy family unavailable");
      },
    });
    assert.equal((await service.getView()).shellAllowed, true);
  });
}

test("fresh required; defer is serialized AceVra-only state and survives restart", async () => {
  const root = await mkdtemp("/tmp/av-");
  try {
    const options = {
      statePath: join(root, "acevra-setup.json"),
      models: {
        getView: async () => ({ revision: 1, providers: [] }),
      } as unknown as IModelSelectionService,
      providers: {} as IProviderSettingsService,
      saveDefault: async () => {},
      readLegacyFamily: async () => undefined,
    };
    const service = createAceVraSetupService(options);
    assert.equal((await service.getView()).shellAllowed, false);
    await Promise.all([service.defer(), service.defer()]);
    const state = JSON.parse(await readFile(options.statePath, "utf8"));
    assert.deepEqual(state, { version: 1, deferred: true, origin: "user" });
    const view = await createAceVraSetupService(options).getView();
    assert.equal(view.shellAllowed, true);
    assert.equal(view.inferenceState, "connection-required");
    assert.ok(join(root, "u", "host.sock").length < 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy explicit family preserves shell without claiming usable models", async () => {
  const root = await mkdtemp("/tmp/av-");
  try {
    const service = createAceVraSetupService({
      statePath: join(root, "state.json"),
      models: {
        getView: async () => ({ revision: 0, providers: [] }),
      } as unknown as IModelSelectionService,
      providers: {} as IProviderSettingsService,
      saveDefault: async () => {},
      readLegacyFamily: async () => "zai",
    });
    assert.equal((await service.getView()).status, "deferred");
    assert.equal((await service.getView()).inferenceState, "connection-required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cards keep ordinary configuration separate from Z.ai auth", async () => {
  const service = createAceVraSetupService({
    statePath: "/tmp/unused-acevra-state",
    models: {} as IModelSelectionService,
    providers: {} as IProviderSettingsService,
    saveDefault: async () => {},
    readLegacyFamily: async () => undefined,
  });
  assert.deepEqual(await service.getProviderRoute("openai"), {
    kind: "api-key",
    templateId: "openai",
  });
  assert.deepEqual(await service.getProviderRoute("anthropic"), {
    kind: "api-key",
    templateId: "anthropic",
  });
  assert.deepEqual(await service.getProviderRoute("compatible"), { kind: "api-key" });
  assert.deepEqual(await service.getProviderRoute("zai"), { kind: "oauth", providerId: "zai" });
});

for (const choice of ["openai", "anthropic", "compatible"] as const) {
  test(`${choice} setup uses existing registry and default repository without family`, async () => {
    const { createProviderConfigRuntime } =
      await import("../../src/model-provider/providerConfigRuntime.js");
    const { createProviderRuntimeFromConfigRuntime } =
      await import("../../src/model-provider/providerRuntime.js");
    const { NodeModelSelectionConfigRepository } = await import("@zcode/provider-node");
    const { fileURLToPath } = await import("node:url");
    const root = await mkdtemp("/tmp/av-");
    const config = createProviderConfigRuntime({
      zcodeBuiltinFilePath: fileURLToPath(
        new URL("../../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      personalFilePath: join(root, "provider_config.json"),
    });
    const defaults = new NodeModelSelectionConfigRepository({
      personalRepository: config.personalRepository,
    });
    const runtime = createProviderRuntimeFromConfigRuntime({
      configRuntime: config,
      modelSelectionConfiguredDefaultSource: defaults,
    });
    try {
      const setup = createAceVraSetupService({
        statePath: join(root, "state.json"),
        models: runtime.modelSelection,
        providers: runtime.providerSettings,
        saveDefault: (selection) => defaults.saveConfiguredDefault(selection),
        readLegacyFamily: async () => undefined,
      });
      assert.equal((await setup.getView()).status, "required");
      const view = await setup.configureConnection({
        choice,
        baseUrl: "http://127.0.0.1:12345/v1",
        apiKey: "acevra-test-sentinel",
        modelId: "acevra-fixture",
        apiType:
          choice === "anthropic"
            ? "anthropic-messages"
            : choice === "openai"
              ? "openai-responses"
              : "openai-chat-completions",
        credentialHeader: choice === "compatible" ? "api-key" : "bearer",
      });
      if (choice === "compatible") {
        const saved = JSON.parse(await readFile(join(root, "provider_config.json"), "utf8"));
        assert.ok(JSON.stringify(saved).includes('"headers":{"api-key":"acevra-test-sentinel"}'));
      }
      assert.equal(view.status, "connected");
      assert.equal(JSON.stringify(view).includes("acevra-test-sentinel"), false);
      assert.equal((await defaults.read())?.modelId, "acevra-fixture");
      assert.equal(view.modelSelection.preferredSelection?.modelId, "acevra-fixture");
      assert.equal((await setup.getView()).shellAllowed, true);
    } finally {
      runtime.dispose();
      defaults.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("corrupt state requires setup and is not overwritten by legacy migration", async () => {
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp("/tmp/av-");
  try {
    const statePath = join(root, "state.json");
    await writeFile(statePath, "broken");
    const service = createAceVraSetupService({
      statePath,
      models: {
        getView: async () => ({ revision: 0, providers: [] }),
      } as unknown as IModelSelectionService,
      providers: {} as IProviderSettingsService,
      saveDefault: async () => {},
      readLegacyFamily: async () => "zai",
    });
    assert.equal((await service.getView()).shellAllowed, false);
    assert.equal(await readFile(statePath, "utf8"), "broken");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote setup cannot write credentials through the new facade", async () => {
  const { createRemoteAceVraSetupGuard } = await import("../../src/onboarding/acevraSetup.js");
  let writes = 0;
  const guarded = createRemoteAceVraSetupGuard({
    configureConnection: async () => {
      writes += 1;
      return {} as never;
    },
  } as never);
  await assert.rejects(
    guarded.configureConnection({
      choice: "openai",
      apiKey: "sentinel",
      modelId: "fixture",
      baseUrl: "http://127.0.0.1/v1",
      apiType: "openai-responses",
    }),
    /local desktop/,
  );
  assert.equal(writes, 0);
});
