import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, ipcMain, type WebContents } from "electron";
import { AccountChannels, type AccountView } from "@zcode/shared";
import { ACCOUNT_TOKEN_STORE_NAME, isAccountSessionPersistent } from "./accountClerkBridge.js";
import { resolveAccountConfig } from "./accountConfig.js";
import { createAccountPreferenceStore } from "./accountPreference.js";
import { createAccountSessionController } from "./accountSessionController.js";
import { resolveTestTokenSource } from "./accountTestTokenSource.js";
import { createAccountWindowTokenSource } from "./accountWindowTokenSource.js";

/** Whether this launch runs the real Clerk window (decided before app ready). */
export function resolveAccountRuntime(env: NodeJS.ProcessEnv, isPackaged: boolean) {
  const config = resolveAccountConfig(env, { isPackaged });
  const testSource = resolveTestTokenSource(env, { isPackaged });
  return {
    config,
    testSource,
    clerkEnabled: Boolean(config?.publishableKey) && !testSource,
  };
}

/**
 * Wires the account controller to IPC. The main renderer only ever sees `AccountView`;
 * Clerk, tokens and the backend call stay in main/Account window.
 */
export function initAccountMain(options: {
  runtime: ReturnType<typeof resolveAccountRuntime>;
  rendererDir: string;
  accountPreloadPath: string;
  fetch?: typeof fetch;
}) {
  const { config, testSource, clerkEnabled } = options.runtime;
  const windowSource =
    clerkEnabled && config?.publishableKey
      ? createAccountWindowTokenSource({
          publishableKey: config.publishableKey,
          rendererDir: options.rendererDir,
          preloadPath: options.accountPreloadPath,
        })
      : null;
  const controller = createAccountSessionController({
    apiBaseUrl: config?.apiBaseUrl ?? null,
    tokenSource: testSource ?? windowSource,
    preference: createAccountPreferenceStore(join(app.getPath("userData"), "acevra-account.json")),
    fetch: options.fetch ?? fetch,
    rememberSession: !windowSource || isAccountSessionPersistent(),
  });

  const subscribers = new Map<number, WebContents>();
  const broadcast = (view: AccountView) => {
    for (const [id, contents] of subscribers) {
      if (contents.isDestroyed()) subscribers.delete(id);
      else contents.send(AccountChannels.ViewChanged, view);
    }
  };
  controller.onViewChanged(broadcast);

  // start() 读取本地偏好；GetView 必须等它完成，否则已选「本地」的用户会闪现账号选择页。
  const started = controller.start();
  ipcMain.handle(AccountChannels.GetView, async (event) => {
    subscribers.set(event.sender.id, event.sender);
    await started.catch(() => undefined);
    return controller.getView();
  });
  ipcMain.handle(AccountChannels.SignIn, () => controller.signIn());
  ipcMain.handle(AccountChannels.SignOut, () => controller.signOut());
  ipcMain.handle(AccountChannels.Refresh, () => controller.refresh());
  ipcMain.handle(AccountChannels.ChooseLocal, () => controller.chooseLocal());

  // Restore only when Clerk has persisted tokens (OS-encrypted); otherwise stay idle.
  const restored = started.then(async () => {
    if (!windowSource || !isAccountSessionPersistent()) return;
    const raw = await readFile(
      join(app.getPath("userData"), `${ACCOUNT_TOKEN_STORE_NAME}.json`),
      "utf8",
    ).catch(() => "{}");
    const keys = Object.keys(JSON.parse(raw || "{}"));
    if (keys.length > 0) await windowSource.restore();
  });

  return {
    controller,
    start: () => restored.catch(() => undefined),
    dispose() {
      controller.dispose();
      windowSource?.dispose();
      for (const channel of [
        AccountChannels.GetView,
        AccountChannels.SignIn,
        AccountChannels.SignOut,
        AccountChannels.Refresh,
        AccountChannels.ChooseLocal,
      ]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}
