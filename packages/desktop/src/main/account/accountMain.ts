import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { app, ipcMain, type WebContents } from "electron";
import { AccountChannels, type AccountDevice, type AccountView } from "@zcode/shared";
import { resolveCuaOsSupport } from "../cuaOsSupport.js";
import { execFile } from "node:child_process";
import { createAccountDevices } from "./accountDevices.js";
import { deriveDesktopCapabilities } from "./accountCapabilities.js";
import { createAgentExecutionHandler } from "./accountAgentExecution.js";
import { createAccountTasks } from "./accountTasks.js";
import { createLocalProcessRunner } from "./localProcessRunner.js";
import { initComputersMain } from "../computers/computersMain.js";
import { createInstallationStore } from "./accountInstallation.js";
import {
  ACCOUNT_TOKEN_STORE_NAME,
  isAccountSessionPersistent,
} from "./accountSessionPersistence.js";
import { resolveAccountConfig } from "./accountConfig.js";
import { resolveEngineeringTools } from "./accountEngineeringTools.js";
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
    engineeringTools: resolveEngineeringTools(env, { isPackaged }),
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

  // Device registry: only meaningful while the account is ready; local features never wait on it.
  const tokenSource = testSource ?? windowSource;
  const devices =
    config && tokenSource
      ? createAccountDevices({
          apiBaseUrl: config.apiBaseUrl,
          getToken: () => tokenSource.getToken(),
          fetch: options.fetch ?? fetch,
          installationId: createInstallationStore(
            join(app.getPath("userData"), "acevra-installation.json"),
          ).getOrCreate,
          describe: async () => ({
            platform: process.platform as AccountDevice["platform"],
            displayName: describeComputerName(),
            capabilities: deriveDesktopCapabilities({
              gitAvailable: await gitProbe,
              computerUseSupported: resolveCuaOsSupport().kind === "supported",
            }),
          }),
          // A rejected bearer on any device/task call is a session-level fact; the
          // controller owns the transition to signed out so the UI offers sign-in.
          onUnauthorized: () => controller.rejectSession(),
        })
      : null;
  let wasReady = false;
  // Probed once, asynchronously, so capability facts never block startup.
  const gitProbe = new Promise<boolean>((resolve) =>
    execFile("git", ["--version"], { timeout: 3000 }, (error) => resolve(!error)),
  );
  controller.onViewChanged((view) => {
    const ready = view.phase === "ready";
    if (ready && !wasReady) void devices?.start().catch(() => undefined);
    if (!ready && wasReady) devices?.stop();
    wasReady = ready;
  });

  // Local execution is independent of the account: it works signed out and offline.
  const local = createLocalProcessRunner();
  // SSH computers are local config too: available signed out (acevra-agent-computer.md).
  const computers = initComputersMain();
  const tasksApi = createAccountTasks({
    local,
    ssh: {
      listTargets: () => computers.service.listTargets(),
      hostAliasFor: (targetId) => computers.service.hostAliasFor(targetId),
      runner: computers.runner,
      noteActivity: (computerId, action) => computers.service.noteActivity(computerId, action),
    },
    call: (method, path, body) => devices?.call(method, path, body) ?? Promise.resolve(null),
    accountReady: () => controller.getView().phase === "ready",
    thisDevice: () => ({
      id: devices?.thisDeviceId() ?? null,
      displayName: describeComputerName(),
      capabilities: deriveDesktopCapabilities({
        gitAvailable: gitKnown,
        computerUseSupported: resolveCuaOsSupport().kind === "supported",
      }),
    }),
  });
  let gitKnown = false;
  void gitProbe.then((ok) => (gitKnown = ok));
  const handleAgentExecution = createAgentExecutionHandler({
    tasks: tasksApi,
    computers: computers.service,
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
  const idle = { registration: "none" as const, thisDeviceId: null, devices: [] };
  ipcMain.handle(AccountChannels.DevicesList, () => devices?.list() ?? idle);
  const unavailable = { status: "unavailable" as const };
  ipcMain.handle(AccountChannels.PairingLookup, (_event, code: unknown) =>
    typeof code === "string" && code.length <= 32
      ? (devices?.lookupPairing(code) ?? unavailable)
      : unavailable,
  );
  ipcMain.handle(AccountChannels.PairingDecide, (_event, id: unknown, decision: unknown) =>
    typeof id === "string" && (decision === "approve" || decision === "reject")
      ? (devices?.decidePairing(id, decision) ?? unavailable)
      : unavailable,
  );
  ipcMain.handle(AccountChannels.DeviceRename, (_event, id: unknown, name: unknown) =>
    typeof id === "string" && typeof name === "string" ? (devices?.rename(id, name) ?? idle) : idle,
  );
  ipcMain.handle(AccountChannels.DeviceRevoke, (_event, id: unknown) =>
    typeof id === "string" ? (devices?.revoke(id) ?? idle) : idle,
  );
  ipcMain.handle(AccountChannels.TargetsList, () => tasksApi.listTargets());
  ipcMain.handle(AccountChannels.TaskStart, (_event, input: unknown) => {
    const request = parseStartRequest(input);
    return request
      ? tasksApi.startRemoteProcess(request)
      : { ok: false, reason: "invalid_request" };
  });
  ipcMain.handle(AccountChannels.TasksList, () => tasksApi.listTasks());
  ipcMain.handle(AccountChannels.TaskEvents, (_event, id: unknown, after: unknown) =>
    typeof id === "string" && id.length <= 80 && typeof after === "number"
      ? tasksApi.getTaskEvents(id, after)
      : [],
  );
  ipcMain.handle(AccountChannels.TaskCancel, (_event, id: unknown, force: unknown) =>
    typeof id === "string" && id.length <= 80 ? tasksApi.cancelTask(id, force === true) : null,
  );
  ipcMain.handle(AccountChannels.ChooseLocal, () => controller.chooseLocal());
  ipcMain.handle(AccountChannels.EngineeringTools, () => options.runtime.engineeringTools);

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
    /** M2F：agent 的 interaction/executionTarget 反向请求入口（只转发，不持有任务状态）。 */
    handleAgentExecution,
    start: () => restored.catch(() => undefined),
    dispose() {
      local.shutdown();
      computers.dispose();
      devices?.stop();
      controller.dispose();
      windowSource?.dispose();
      for (const channel of [
        AccountChannels.GetView,
        AccountChannels.SignIn,
        AccountChannels.SignOut,
        AccountChannels.Refresh,
        AccountChannels.ChooseLocal,
        AccountChannels.DevicesList,
        AccountChannels.TargetsList,
        AccountChannels.TaskStart,
        AccountChannels.TasksList,
        AccountChannels.TaskEvents,
        AccountChannels.TaskCancel,
        AccountChannels.PairingLookup,
        AccountChannels.PairingDecide,
        AccountChannels.DeviceRename,
        AccountChannels.DeviceRevoke,
        AccountChannels.EngineeringTools,
      ]) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}

/** Friendly default name only (e.g. "Felipes-MacBook-Pro"); a hostname is never an identity. */
function describeComputerName(): string {
  const cleaned = hostname()
    .replace(/\.(local|lan|home)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N} '’.]/gu, "")
    .trim()
    .slice(0, 60);
  return cleaned || "This computer";
}

/** Validates the renderer's start request; anything unexpected is dropped before it reaches a runner. */
function parseStartRequest(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const { targetId, process: p, idempotencyKey } = input as Record<string, unknown>;
  if (typeof targetId !== "string" || targetId.length > 80 || !p || typeof p !== "object")
    return null;
  const { executable, args, cwd, env, timeoutMs } = p as Record<string, unknown>;
  if (typeof executable !== "string" || typeof cwd !== "string") return null;
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === "string")))
    return null;
  if (env !== undefined && (typeof env !== "object" || env === null)) return null;
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") return null;
  return {
    targetId,
    process: {
      executable,
      args: args as string[] | undefined,
      cwd,
      env: env as Record<string, string> | undefined,
      timeoutMs: timeoutMs as number | undefined,
    },
    ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
  };
}
