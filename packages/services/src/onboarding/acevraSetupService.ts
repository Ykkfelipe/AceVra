import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { completeNewModelSelection, type ModelSelection } from "@zcode/provider";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "../model-provider/providerFacadeServices.js";
import type {
  AceVraProviderChoice,
  AceVraProviderRoute,
  IAceVraSetupService,
} from "./acevraSetup.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("acevra-setup");
export interface AceVraSetupOptions {
  statePath: string;
  models: IModelSelectionService;
  providers: IProviderSettingsService;
  saveDefault(selection: ModelSelection): Promise<unknown>;
  readLegacyFamily(): Promise<string | null | undefined>;
}
export function createAceVraSetupService(options: AceVraSetupOptions): IAceVraSetupService {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  const writeDeferred = async (origin: "user" | "legacy") => {
    await mkdir(dirname(options.statePath), { recursive: true });
    await atomicWriteText(
      options.statePath,
      JSON.stringify({ version: 1, deferred: true, origin }),
    );
  };
  const readDeferred = async (): Promise<boolean> => {
    try {
      const state: unknown = JSON.parse(await readFile(options.statePath, "utf8"));
      return (
        typeof state === "object" &&
        state !== null &&
        "version" in state &&
        state.version === 1 &&
        "deferred" in state &&
        state.deferred === true
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 损坏状态不能伪装完成；保留文件并要求用户明确选择，日志不包含文件内容。
        logger.warn(undefined, "AceVra setup state unavailable", {
          code: (error as NodeJS.ErrnoException).code ?? "invalid-state",
        });
        return false;
      }
      // 旧版跳过也写 family；只迁移为 deferred，绝不把 family 当可用模型事实。
      const family = await options.readLegacyFamily();
      if (family === "zai" || family === "bigmodel") {
        await writeDeferred("legacy");
        return true;
      }
      return false;
    }
  };
  const route = (choice: AceVraProviderChoice): AceVraProviderRoute => {
    switch (choice) {
      case "zai":
        return { kind: "oauth", providerId: "zai" };
      case "openai":
      case "anthropic":
        return { kind: "api-key", templateId: choice };
      case "compatible":
        return { kind: "api-key" };
      default:
        throw new Error("Unknown provider choice");
    }
  };
  const getView = async () => {
    const modelSelection = await options.models.getView();
    const usable = modelSelection.providers.some((provider) => provider.models.length > 0);
    // 普通 Provider 已就绪时不读 legacy family；旧账号/状态读取失败不能重新挡住启动。
    const deferred = usable ? false : await serialize(readDeferred);
    return {
      status: usable
        ? ("connected" as const)
        : deferred
          ? ("deferred" as const)
          : ("required" as const),
      shellAllowed: usable || deferred,
      inferenceState: usable ? ("ready" as const) : ("connection-required" as const),
      modelSelection,
    };
  };
  return {
    getView,
    getProviderRoute: async (choice) => route(choice),
    defer: async () => {
      await serialize(() => writeDeferred("user"));
      return getView();
    },
    configureConnection: async (input) => {
      const target = route(input.choice);
      if (target.kind !== "api-key")
        throw new Error("Use the provider-specific authentication flow");
      if (!input.apiKey.trim() || !input.modelId.trim())
        throw new Error("API key and model are required");
      const url = new URL(input.baseUrl);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Use an HTTP or HTTPS endpoint");
      const created = await options.providers.createPersonalProvider({
        ...(target.templateId
          ? { templateId: target.templateId }
          : { providerName: "OpenAI-compatible" }),
        initialConfig: {
          access: { type: "api-key", apiKey: input.apiKey.trim() },
          api: {
            type: input.apiType,
            baseUrl: input.baseUrl.trim(),
            ...(input.credentialHeader === "api-key"
              ? { headers: { "api-key": input.apiKey.trim() } }
              : {}),
          },
        },
      });
      await options.providers.addPersonalModel(created.providerId, input.modelId.trim(), {}, true);
      const view = await options.models.getView();
      const selection = completeNewModelSelection(view, {
        providerId: created.providerId,
        modelId: input.modelId.trim(),
      });
      if (!selection)
        throw new Error("Connect a provider and select an available model to continue");
      await options.saveDefault(selection);
      return getView();
    },
  };
}
