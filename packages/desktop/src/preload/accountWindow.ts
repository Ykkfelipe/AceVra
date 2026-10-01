/**
 * Preload for the dedicated Account window ONLY (never the main window).
 * Exposes the official Clerk bridge plus a minimal request/reply channel so main can
 * ask for a fresh session token. No tokens are cached here.
 */
import { contextBridge, ipcRenderer } from "electron";
import { exposeClerkBridge } from "@clerk/electron/preload";
import { AccountChannels } from "@zcode/shared";

type WindowRequest = { id: string; kind: "getToken" | "signOut" };
type Handler = (kind: WindowRequest["kind"]) => Promise<unknown>;

exposeClerkBridge();
contextBridge.exposeInMainWorld("acevraAccountWindow", {
  getConfig: (): Promise<{ publishableKey: string }> =>
    ipcRenderer.invoke(AccountChannels.WindowGetConfig),
  reportSession: (signedIn: boolean) => ipcRenderer.send(AccountChannels.WindowSession, signedIn),
  onRequest: (handler: Handler) => {
    const listener = (_event: unknown, request: WindowRequest) => {
      void handler(request.kind)
        .catch(() => null)
        .then((value) => ipcRenderer.send(AccountChannels.WindowReply, { id: request.id, value }));
    };
    ipcRenderer.on(AccountChannels.WindowRequest, listener);
    return () => ipcRenderer.removeListener(AccountChannels.WindowRequest, listener);
  },
});
