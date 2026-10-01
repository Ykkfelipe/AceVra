import { ServiceChannels } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { createServiceDescriptor } from "../descriptors.js";

export type AceVraProviderChoice = "openai" | "anthropic" | "zai" | "compatible";
export type AceVraProviderRoute =
  | { kind: "oauth"; providerId: "zai" }
  | { kind: "api-key"; templateId?: "openai" | "anthropic" };
export interface AceVraSetupView {
  status: "required" | "connected" | "deferred";
  shellAllowed: boolean;
  inferenceState: "ready" | "connection-required";
  modelSelection: ModelSelectionView;
}
export interface AceVraConnectionInput {
  choice: Exclude<AceVraProviderChoice, "zai">;
  apiKey: string;
  credentialHeader?: "bearer" | "api-key";
  baseUrl: string;
  modelId: string;
  apiType: "openai-responses" | "openai-chat-completions" | "anthropic-messages";
}
export interface IAceVraSetupService {
  getView(): Promise<AceVraSetupView>;
  defer(): Promise<AceVraSetupView>;
  getProviderRoute(choice: AceVraProviderChoice): Promise<AceVraProviderRoute>;
  configureConnection(input: AceVraConnectionInput): Promise<AceVraSetupView>;
}
export const IAceVraSetupService = createServiceDescriptor<IAceVraSetupService>(
  ServiceChannels.AceVraSetup,
);

/** WebSocket clients retain the same credential boundary as ProviderSettings. */
export function createRemoteAceVraSetupGuard(service: IAceVraSetupService): IAceVraSetupService {
  return {
    getView: () => service.getView(),
    getProviderRoute: (choice) => service.getProviderRoute(choice),
    defer: () => service.defer(),
    configureConnection: async () => {
      throw new Error("Provider credentials can only be configured in the local desktop app");
    },
  };
}
