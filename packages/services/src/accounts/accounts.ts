import { ServiceChannels } from "@zcode/shared";
import type {
  AccountBridgeConnectResult,
  AccountBridgeSource,
  AccountBridgeStatus,
  ZCodeImportableSessionCandidate,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { CommandCodeStatus } from "./commandCodeStatusAdapter.js";

/**
 * Accounts & Imports service.
 *
 * SECURITY BOUNDARY: every method returns sanitized data only. No OAuth access or refresh
 * token, no `~/.codex/auth.json` content, no Claude credential and no Command Code API key
 * may cross this interface. The Codex OAuth URL is opened on the host and is never returned.
 */
export interface IAccountsService {
  /** Sanitized status for one source. */
  readAccountStatus(source: AccountBridgeSource): Promise<AccountBridgeStatus>;
  /** Sanitized status for every supported source. */
  readAllAccountStatuses(): Promise<readonly AccountBridgeStatus[]>;
  /** Explicit user action. For Codex the OAuth URL opens on the HOST, never the browser. */
  connectAccount(source: AccountBridgeSource): Promise<AccountBridgeConnectResult>;
  /** Cancel an in-flight login. */
  cancelAccountConnect(source: AccountBridgeSource, loginId?: string): Promise<void>;
  /** Disable the harness-side bridge ONLY; never logs the source application out. */
  disconnectAccount(source: AccountBridgeSource): Promise<AccountBridgeStatus>;
  /** Restart the host bridge process without touching credentials. */
  reconnectAccountBridge(source: AccountBridgeSource): Promise<AccountBridgeStatus>;
  /** Command Code account/usage status from its supported CLI surface. */
  readCommandCodeStatus(): Promise<CommandCodeStatus>;
  /** Codex history candidates. Works regardless of account connection state. */
  scanCodexHistory(options?: {
    workspacePath?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<readonly ZCodeImportableSessionCandidate[]>;
}

export const IAccountsService = createServiceDescriptor<IAccountsService>(
  ServiceChannels.Accounts,
);
