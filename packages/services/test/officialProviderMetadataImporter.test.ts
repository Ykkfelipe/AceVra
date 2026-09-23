import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { importOfficialProviderMetadata } from "../src/model-provider/officialProviderMetadataImporter.js";

const SENTINEL = "FAKE_OFFICIAL_PROVIDER_SECRET_SENTINEL";

test("official metadata import is secret-free, preserves model rules, and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-official-provider-import-"));
  const sourcePath = join(directory, "official-provider-config.json");
  const targetPath = join(directory, "fork-provider-config.json");
  const sourceConfig = encodeProviderConfigFile({
    providers: new ProviderConfigMap([
      {
        providerId: "azure-openai",
        providerName: "Azure OpenAI",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: SENTINEL }),
          api: new ProviderApiConfig({
            type: "openai-chat-completions",
            baseUrl: "https://azure.example/openai/v1?api-key=" + SENTINEL,
            headers: { Authorization: `Bearer ${SENTINEL}` },
          }),
          personalModelIds: ["gpt-5-mini"],
          modelOrder: ["gpt-5-mini"],
        }),
      },
      {
        providerId: "command-code",
        providerName: "Command Code",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: SENTINEL }),
          api: new ProviderApiConfig({
            type: "openai-chat-completions",
            baseUrl: "https://command.example/provider/v1",
            headers: { "x-api-key": SENTINEL },
          }),
          personalModelIds: ["z-ai/glm-5.3-flash"],
          modelOrder: ["z-ai/glm-5.3-flash"],
        }),
      },
    ]),
    models: ModelConfigRules.empty().setExact(
      "azure-openai",
      "gpt-5-mini",
      new ModelConfig({
        properties: new ModelPropertiesConfig({
          contextWindow: 272_000,
          supportsToolCall: true,
          supportsJsonSchemaOutput: true,
        }),
      }),
    ),
  });
  const originalSource = `${JSON.stringify(sourceConfig, null, 2)}\n`;
  await writeFile(sourcePath, originalSource, { mode: 0o600 });
  const repository = new NodePersonalProviderConfigRepository({
    filePath: targetPath,
    pollingIntervalMs: false,
  });

  try {
    const first = await importOfficialProviderMetadata({
      sourceFilePath: sourcePath,
      targetFilePath: targetPath,
      updateTarget: (transform) => repository.update(transform),
    });
    assert.deepEqual(first.importedProviderIds, ["azure-openai", "command-code"]);
    const targetText = await readFile(targetPath, "utf8");
    assert.equal(targetText.includes(SENTINEL), false);
    const target = decodeProviderConfigFile(JSON.parse(targetText));
    assert.deepEqual(target.providers.get("azure-openai")?.personalModelIds, ["gpt-5-mini"]);
    assert.deepEqual(target.providers.get("command-code")?.personalModelIds, ["z-ai/glm-5.3-flash"]);
    assert.equal(target.models.getExact("azure-openai", "gpt-5-mini")?.properties?.contextWindow, 272_000);

    const second = await importOfficialProviderMetadata({
      sourceFilePath: sourcePath,
      targetFilePath: targetPath,
      updateTarget: (transform) => repository.update(transform),
    });
    assert.deepEqual(second.importedProviderIds, []);
    assert.equal((await readFile(sourcePath, "utf8")), originalSource);
  } finally {
    repository.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing fork provider definitions take precedence over official metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-provider-import-precedence-"));
  const sourcePath = join(directory, "source.json");
  const targetPath = join(directory, "target.json");
  const source = encodeProviderConfigFile({
    providers: new ProviderConfigMap([
      ["azure-openai", new ProviderConfig({
        group: "standard-personal",
        api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: "https://official.example" }),
      })],
    ]),
    models: ModelConfigRules.empty(),
  });
  await writeFile(sourcePath, JSON.stringify(source));
  const existing = encodeProviderConfigFile({
    providers: new ProviderConfigMap([
      ["azure-openai", new ProviderConfig({
        group: "standard-personal",
        api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: "https://fork.example" }),
      })],
    ]),
    models: ModelConfigRules.empty(),
  });
  await writeFile(targetPath, JSON.stringify(existing));
  const repository = new NodePersonalProviderConfigRepository({ filePath: targetPath, pollingIntervalMs: false });
  try {
    const result = await importOfficialProviderMetadata({
      sourceFilePath: sourcePath,
      targetFilePath: targetPath,
      updateTarget: (transform) => repository.update(transform),
    });
    assert.deepEqual(result.importedProviderIds, []);
    assert.equal((await repository.read()).providers.get("azure-openai")?.api?.baseUrl, "https://fork.example");
  } finally {
    repository.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
