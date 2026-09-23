/**
 * Host-side implementation of IAccountsService.
 *
 * This is the ONLY component that may talk to the local Codex / Claude / Command Code
 * clients. It composes the account bridge, the Command Code status adapter and the Codex
 * history scanner, and returns sanitized shapes exclusively.
 */
import type {
  AccountBridgeConnectResult,
  AccountBridgeSource,
  AccountBridgeStatus,
} from "@zcode/shared";
import type { IAccountsService } from "#src/accounts/accounts.js";
import {
  createAccountBridgeService,
  type AccountBridgeServiceDeps,
} from "#src/accounts/accountBridgeService.js";
import {
  readCommandCodeStatus,
  type CommandCodeStatus,
} from "#src/accounts/commandCodeStatusAdapter.js";

export interface AccountsServiceOptions extends AccountBridgeServiceDeps {
  readonly commandCodeExecutable?: string;
}

export function createAccountsService(options: AccountsServiceOptions): IAccountsService & {
  dispose(): void;
} {
  const bridge = createAccountBridgeService(options);
  const commandCodeBin = options.commandCodeExecutable ?? "commandcode";

  return {
    async readAccountStatus(source: AccountBridgeSource): Promise<AccountBridgeStatus> {
      return bridge.readStatus(source);
    },
    async readAllAccountStatuses(): Promise<readonly AccountBridgeStatus[]> {
      return bridge.readAllStatuses();
    },
    async connectAccount(source: AccountBridgeSource): Promise<AccountBridgeConnectResult> {
      return bridge.connect(source);
    },
    async cancelAccountConnect(source: AccountBridgeSource, loginId?: string): Promise<void> {
      return bridge.cancelConnect(source, loginId);
    },
    async disconnectAccount(source: AccountBridgeSource): Promise<AccountBridgeStatus> {
      return bridge.disconnect(source);
    },
    async reconnectAccountBridge(source: AccountBridgeSource): Promise<AccountBridgeStatus> {
      return bridge.reconnectBridge(source);
    },
    async readCommandCodeStatus(): Promise<CommandCodeStatus> {
      return readCommandCodeStatus(commandCodeBin);
    },
    dispose(): void {
      bridge.dispose();
    },
  };
}
