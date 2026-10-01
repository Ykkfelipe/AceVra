import { spawn } from "node:child_process";
import { join } from "node:path";
import { app, ipcMain, nativeImage, type WebContents } from "electron";
import { WebSocket } from "ws";
import {
  ComputerChannels,
  DEFAULT_WORKER_PORT,
  type CapturedKeyEvent,
  type ComputerFrame,
  type ComputerImage,
  type ComputerView,
} from "@zcode/shared";
import { createComputersService } from "./computersService.js";
import { sanitizeInputEvent, type ViewSocket } from "./computerViewStream.js";
import {
  createSshComputersStore,
  isValidHostAlias,
  isValidWorkerPort,
} from "./sshComputersStore.js";
import { createSshProcessRunner } from "./sshProcessRunner.js";

const MAX_INPUT_BATCH = 64;

function encodeScreenshot(png: Buffer): ComputerImage | null {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  return { base64: image.toJPEG(75).toString("base64"), mimeType: "image/jpeg", width, height };
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 80;

/**
 * IPC for SSH computers. Main owns tunnels, the token (memory only), the view socket and the SSH
 * process runner; renderers only get views, frames and command results.
 */
export function initComputersMain() {
  const store = createSshComputersStore(
    join(app.getPath("userData"), "computers", "ssh-computers.json"),
  );
  const viewers = new Map<number, WebContents>();
  const broadcastView = (view: ComputerView) => {
    for (const [id, contents] of viewers) {
      if (contents.isDestroyed()) viewers.delete(id);
      else contents.send(ComputerChannels.ViewChanged, view);
    }
  };
  const service = createComputersService({
    store,
    spawn,
    fetch,
    openSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as ViewSocket,
    encodeScreenshot,
    onView: broadcastView,
  });
  const runner = createSshProcessRunner({ spawn });
  /** `${webContentsId}:${subscriptionId}` → unsubscribe. */
  const subscriptions = new Map<string, () => void>();
  /**
   * 远程键盘捕获（spec §3.3 layer 1）：renderer 在接管且聚焦时开启。Electron 原生菜单 accelerator
   * （Cmd+Q / Cmd+W 等）不经过 renderer 事件，必须在 Main 用 before-input-event 抢先拦截，
   * preventDefault 后把原始键事件转发回 renderer 走同一条 mapKeyEvent → sendInput 路径。
   */
  const keyCapture = new Set<number>();

  const track = (contents: WebContents) => {
    if (viewers.has(contents.id)) return;
    viewers.set(contents.id, contents);
    contents.on("before-input-event", (event, input) => {
      if (!keyCapture.has(contents.id)) return;
      if (event.type !== "keyDown" && event.type !== "keyUp") return;
      if (input.type !== "keyDown" && input.type !== "keyUp") return;
      event.preventDefault();
      contents.send(ComputerChannels.CapturedKey, {
        type: input.type === "keyDown" ? "keydown" : "keyup",
        key: input.key,
        code: input.code,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        isAutoRepeat: input.isAutoRepeat,
      } satisfies CapturedKeyEvent);
    });
    contents.once("destroyed", () => {
      viewers.delete(contents.id);
      keyCapture.delete(contents.id);
      for (const [key, off] of subscriptions) {
        if (key.startsWith(`${contents.id}:`)) {
          off();
          subscriptions.delete(key);
        }
      }
    });
  };

  ipcMain.handle(ComputerChannels.List, (event) => {
    track(event.sender);
    return store.list();
  });
  ipcMain.handle(ComputerChannels.Test, (_event, input: unknown) => {
    const { hostAlias, workerPort } = (input ?? {}) as Record<string, unknown>;
    if (typeof hostAlias !== "string" || !isValidHostAlias(hostAlias))
      return { ok: false, reason: "invalid_host" };
    const port = typeof workerPort === "number" ? workerPort : DEFAULT_WORKER_PORT;
    if (!isValidWorkerPort(port)) return { ok: false, reason: "invalid_port" };
    return service.test({ hostAlias, workerPort: port });
  });
  ipcMain.handle(ComputerChannels.Add, async (_event, input: unknown) => {
    const { name, hostAlias, workerPort } = (input ?? {}) as Record<string, unknown>;
    if (typeof hostAlias !== "string" || !isValidHostAlias(hostAlias)) return store.list();
    const port = typeof workerPort === "number" ? workerPort : DEFAULT_WORKER_PORT;
    if (!isValidWorkerPort(port)) return store.list();
    return (
      (await store.add({
        name: typeof name === "string" ? name : hostAlias,
        hostAlias,
        workerPort: port,
      })) ?? store.list()
    );
  });
  ipcMain.handle(ComputerChannels.Remove, async (_event, id: unknown) => {
    if (!isId(id)) return store.list();
    await service.forget(id);
    return store.remove(id);
  });
  ipcMain.handle(ComputerChannels.GetView, (event, id: unknown) => {
    track(event.sender);
    return isId(id) ? service.getView(id) : null;
  });
  ipcMain.on(ComputerChannels.Subscribe, (event, raw: unknown) => {
    const { computerId, subscriptionId, interactive } = (raw ?? {}) as Record<string, unknown>;
    if (!isId(computerId) || !isId(subscriptionId)) return;
    const contents = event.sender;
    track(contents);
    const key = `${contents.id}:${subscriptionId}`;
    subscriptions.get(key)?.();
    subscriptions.set(
      key,
      service.subscribe(computerId, {
        interactive: interactive === true,
        onCursor: (cursor) => {
          if (contents.isDestroyed()) return;
          contents.send(ComputerChannels.Cursor, { computerId, ...cursor });
        },
        onFrame: (meta, jpeg) => {
          if (contents.isDestroyed()) return;
          const frame: ComputerFrame = {
            computerId,
            sourceId: computerId,
            executionTargetId: computerId,
            seq: meta.seq,
            capturedAt: meta.capturedAt,
            width: meta.width,
            height: meta.height,
            screenWidth: meta.sw,
            screenHeight: meta.sh,
            cursorX: meta.cx,
            cursorY: meta.cy,
            jpeg,
          };
          contents.send(ComputerChannels.Frame, frame);
        },
      }),
    );
  });
  ipcMain.on(ComputerChannels.Unsubscribe, (event, subscriptionId: unknown) => {
    if (!isId(subscriptionId)) return;
    const key = `${event.sender.id}:${subscriptionId}`;
    subscriptions.get(key)?.();
    subscriptions.delete(key);
  });
  ipcMain.on(ComputerChannels.Input, (_event, computerId: unknown, events: unknown) => {
    if (!isId(computerId) || !Array.isArray(events)) return;
    const clean = events.slice(0, MAX_INPUT_BATCH).flatMap((raw) => {
      const ev = sanitizeInputEvent(raw);
      return ev ? [ev] : [];
    });
    if (clean.length > 0) service.sendInput(computerId, clean);
  });
  ipcMain.on(ComputerChannels.KeyCapture, (event, active: unknown) => {
    if (active === true) keyCapture.add(event.sender.id);
    else keyCapture.delete(event.sender.id);
  });
  const commands = [
    [ComputerChannels.TakeControl, service.takeControl],
    [ComputerChannels.GiveBack, service.giveBack],
    [ComputerChannels.Resume, service.resume],
    [ComputerChannels.Stop, service.stop],
  ] as const;
  for (const [channel, run] of commands) {
    ipcMain.handle(channel, async (_event, id: unknown) => {
      if (!isId(id)) return { ok: false, reason: "invalid_request" };
      const result = await run(id);
      // Stop 同时取消这台电脑上本会话发起的终端任务（真实 Stop，不只是界面隐藏）。
      if (channel === ComputerChannels.Stop) runner.cancelForTarget(`ssh:${id}`);
      return result;
    });
  }

  return {
    service,
    runner,
    dispose() {
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
      service.dispose();
      runner.shutdown();
      for (const channel of [
        ComputerChannels.List,
        ComputerChannels.Test,
        ComputerChannels.Add,
        ComputerChannels.Remove,
        ComputerChannels.GetView,
        ...commands.map(([channel]) => channel),
      ]) {
        ipcMain.removeHandler(channel);
      }
      for (const channel of [
        ComputerChannels.Subscribe,
        ComputerChannels.Unsubscribe,
        ComputerChannels.Input,
        ComputerChannels.KeyCapture,
      ]) {
        ipcMain.removeAllListeners(channel);
      }
    },
  };
}
