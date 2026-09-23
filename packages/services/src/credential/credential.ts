import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 凭据管理服务
 *
 * 提供 key-value 形式的凭据读写。
 * 实现端（host process）负责加密存储细节，
 * 消费端（renderer）只通过 RPC 调用，不感知存储位置。
 */
export interface ICredentialService {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ICredentialService = createServiceDescriptor<ICredentialService>(
  ServiceChannels.Credential,
);

/** Renderer attachments never receive the raw credential-store capability. */
export function createRendererCredentialDeniedService(): ICredentialService {
  const denied = async (): Promise<never> => {
    throw new Error("Credential storage is host-only");
  };
  return Object.freeze({ load: denied, save: denied, delete: denied });
}
