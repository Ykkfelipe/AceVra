import { randomUUID } from "node:crypto";
import { BrowserWindow, app, ipcMain, net, shell } from "electron";
import { pathToFileURL } from "node:url";
import { ACCOUNT_RENDERER_ORIGIN, AccountChannels } from "@zcode/shared";
import { buildAccountCsp, resolveAccountAsset } from "./accountProtocol.js";
import type { AccountTokenSource } from "./accountSessionController.js";

const REQUEST_TIMEOUT_MS = 10_000;
/** Memory-only session partition: Clerk browser state never touches the AceVra profile. */
const PARTITION = "acevra-account";

interface WindowRequest {
  id: string;
  kind: "getToken" | "signOut";
}

/**
 * Account window = the only place a Clerk SDK runs. It serves bundled assets from
 * `acevra-account://renderer/` (never `file://`), so Clerk sees a stable allowlistable
 * origin. Main asks it for a fresh token per backend request; tokens are not retained.
 */
export function createAccountWindowTokenSource(options: {
  publishableKey: string;
  rendererDir: string;
  preloadPath: string;
}): AccountTokenSource & { dispose(): void; restore(): Promise<void> } {
  let window: BrowserWindow | null = null;
  let signedIn = false;
  let quitting = false;
  const listeners = new Set<(signedIn: boolean) => void>();
  const pending = new Map<string, (value: unknown) => void>();
  const csp = buildAccountCsp(options.publishableKey);

  const emit = (value: boolean) => {
    signedIn = value;
    for (const listener of listeners) listener(value);
  };
  const fromWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    window !== null &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    (event.senderFrame?.url ?? "").startsWith(ACCOUNT_RENDERER_ORIGIN);

  let protocolInstalled = false;
  function installProtocol(win: BrowserWindow) {
    if (protocolInstalled) return;
    protocolInstalled = true;
    win.webContents.session.protocol.handle("acevra-account", async (request) => {
      const file = resolveAccountAsset(request.url, options.rendererDir);
      if (!file) return new Response("Not found", { status: 404 });
      const response = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", csp);
      return new Response(response.body, { status: response.status, headers });
    });
  }

  function ensureWindow(visible = true): BrowserWindow {
    if (window && !window.isDestroyed()) return window;
    const win = new BrowserWindow({
      width: 460,
      height: 640,
      show: false,
      title: "AceVra Account",
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: PARTITION,
      },
    });
    window = win;
    installProtocol(win);
    // Foreign navigation or popups must never inherit this privileged preload.
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${ACCOUNT_RENDERER_ORIGIN}/`)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.once("ready-to-show", () => {
      if (visible) win.show();
    });
    win.on("close", (event) => {
      // A signed-in window keeps serving token requests; hide it instead of closing.
      if (signedIn && !quitting) {
        event.preventDefault();
        win.hide();
      }
    });
    win.on("closed", () => {
      window = null;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      // Closed without a session = sign-in dismissed.
      if (!quitting) emit(false);
    });
    void win.loadURL(`${ACCOUNT_RENDERER_ORIGIN}/`);
    return win;
  }

  function request(kind: WindowRequest["kind"]): Promise<unknown> {
    const win = window;
    if (!win || win.isDestroyed()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      win.webContents.send(AccountChannels.WindowRequest, { id, kind } satisfies WindowRequest);
    });
  }

  ipcMain.handle(AccountChannels.WindowGetConfig, (event) => {
    if (!fromWindow(event)) throw new Error("Untrusted account window request");
    return { publishableKey: options.publishableKey };
  });
  ipcMain.on(AccountChannels.WindowSession, (event, state: unknown) => {
    if (!fromWindow(event) || typeof state !== "boolean") return;
    if (state === signedIn) {
      // A hidden restore attempt that found no session leaves nothing running.
      if (!state && window && !window.isVisible()) window.destroy();
      return;
    }
    if (state) window?.hide();
    emit(state);
  });
  ipcMain.on(AccountChannels.WindowReply, (event, reply: { id?: string; value?: unknown }) => {
    if (!fromWindow(event) || typeof reply?.id !== "string") return;
    pending.get(reply.id)?.(reply.value);
    pending.delete(reply.id);
  });
  const beforeQuit = () => {
    quitting = true;
  };
  app.on("before-quit", beforeQuit);

  return {
    async signIn() {
      const win = ensureWindow();
      if (signedIn) emit(true);
      else if (win.isVisible()) win.focus();
      else if (!win.webContents.isLoading()) win.show();
    },
    /** Boot a hidden window so Clerk can restore a persisted session; no UI unless needed. */
    async restore() {
      if (!window) ensureWindow(false);
    },
    async getToken() {
      if (!signedIn) return null;
      const value = await request("getToken");
      return typeof value === "string" && value ? value : null;
    },
    async signOut() {
      try {
        await request("signOut");
      } finally {
        const win = window;
        signedIn = false;
        if (win && !win.isDestroyed()) win.destroy();
        window = null;
        emit(false);
      }
    },
    onSession(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      app.removeListener("before-quit", beforeQuit);
      ipcMain.removeHandler(AccountChannels.WindowGetConfig);
      ipcMain.removeAllListeners(AccountChannels.WindowSession);
      ipcMain.removeAllListeners(AccountChannels.WindowReply);
      listeners.clear();
    },
  };
}
