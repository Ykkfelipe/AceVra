// Screen takeover glow (zcode-cua/specs/computer-use.md "Screen takeover").
//
// Presentation only: Main owns these overlay windows and nothing else. The renderer drives them
// from the authority's control status with a heartbeat; if no heartbeat arrives within
// HEARTBEAT_TIMEOUT_MS (renderer hung, window closed, lease state lost) the glow hides itself, so
// it can never outlive the takeover it describes.
//
// Windows are transparent, click-through, non-focusable and above layer 0: the Helper's
// topmostWindow hit-test only considers layer-0 windows, and input still reaches the app below.
// Content protection keeps the glow out of screen captures so the agent's own observations are
// never polluted by it.
import { BrowserWindow, ipcMain, screen, type Display } from "electron";
import { PlatformChannels } from "@zcode/shared";
import {
  DEFAULT_HINT,
  DEFAULT_LABEL,
  parseScreenTakeoverOverlayPayload,
  screenTakeoverOverlayHtml,
  type ScreenTakeoverOverlayUpdate,
} from "./screenTakeoverOverlayHtml.js";
import {
  createTakeoverCursorFollower,
  TAKEOVER_CURSOR_SIZE,
  takeoverCursorHtml,
} from "./screenTakeoverCursor.js";

export type { ScreenTakeoverOverlayUpdate } from "./screenTakeoverOverlayHtml.js";

export const SCREEN_TAKEOVER_HEARTBEAT_TIMEOUT_MS = 4_000;

export interface ScreenTakeoverOverlay {
  update(state: ScreenTakeoverOverlayUpdate): void;
  dispose(): void;
}

/** Glow and reticle share one window contract: presentation only, never in the agent's view. */
function createPresentationWindow(
  bounds: { x: number; y: number; width: number; height: number },
  html: string,
  relativeLevel = 0,
): BrowserWindow {
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    webPreferences: {
      // 纯 CSS 展示：不需要脚本、Node 或 preload。
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.setIgnoreMouseEvents(true);
  window.setAlwaysOnTop(true, "screen-saver", relativeLevel);
  // 修复依据（2026-10-03 实测）：缺省时 Electron 以 app.dock.hide() 实现 visibleOnFullScreen，每次接管的
  // 第一帧辉光就把 AceVra 变成 UIElement 且永不恢复——主窗口隐藏且无法激活、Dock/⌘-Tab 消失，任务仍在后台
  // 运行。展示层绝不能改变自身进程类型（specs/computer-use.md "Screen takeover" 第 6 条）。
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.setContentProtection(true);
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.showInactive();
  });
  return window;
}

function createOverlayWindow(display: Display, html: string): BrowserWindow {
  return createPresentationWindow(display.bounds, html);
}

/**
 * Agent cursor reticle (specs/computer-use.md "Visible agent pointer"): one small window above the
 * glow that follows the real pointer only while the takeover glow is shown.
 */
function createCursorReticle(): { dispose(): void } {
  const origin = screen.getCursorScreenPoint();
  const half = TAKEOVER_CURSOR_SIZE / 2;
  const window = createPresentationWindow(
    {
      x: Math.round(origin.x - half),
      y: Math.round(origin.y - half),
      width: TAKEOVER_CURSOR_SIZE,
      height: TAKEOVER_CURSOR_SIZE,
    },
    takeoverCursorHtml(),
    1,
  );
  const follower = createTakeoverCursorFollower({
    size: TAKEOVER_CURSOR_SIZE,
    getCursorPoint: () => screen.getCursorScreenPoint(),
    moveTo: (x, y) => {
      if (!window.isDestroyed()) window.setPosition(x, y, false);
    },
  });
  follower.start();
  return {
    dispose() {
      follower.stop();
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

export function createScreenTakeoverOverlay(options: {
  warn: (message: string) => void;
}): ScreenTakeoverOverlay {
  let windows: BrowserWindow[] = [];
  let shownText: string | null = null;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;

  let reticle: { dispose(): void } | undefined;

  const hide = (): void => {
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = undefined;
    shownText = null;
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    windows = [];
    reticle?.dispose();
    reticle = undefined;
  };

  const show = (label: string, hint: string): void => {
    const text = `${label}\n${hint}`;
    if (shownText === text && windows.every((window) => !window.isDestroyed())) return;
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    const primary = screen.getPrimaryDisplay().id;
    try {
      windows = screen
        .getAllDisplays()
        .map((display) =>
          createOverlayWindow(
            display,
            screenTakeoverOverlayHtml({ withPill: display.id === primary, label, hint }),
          ),
        );
      shownText = text;
      // 准星与辉光同生命周期；显示器变化重建辉光时保留同一个准星。
      reticle ??= createCursorReticle();
    } catch (error) {
      options.warn(
        `[screen-takeover] overlay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      hide();
    }
  };

  // 显示器增减时按当前文案重建，发光层始终覆盖全部屏幕。
  const rebuild = (): void => {
    if (shownText === null) return;
    const [label = DEFAULT_LABEL, hint = DEFAULT_HINT] = shownText.split("\n");
    shownText = null;
    show(label, hint);
  };
  screen.on("display-added", rebuild);
  screen.on("display-removed", rebuild);
  screen.on("display-metrics-changed", rebuild);

  return {
    update(state) {
      if (!state.active) {
        hide();
        return;
      }
      show(state.label ?? DEFAULT_LABEL, state.hint ?? DEFAULT_HINT);
      if (heartbeat) clearTimeout(heartbeat);
      heartbeat = setTimeout(hide, SCREEN_TAKEOVER_HEARTBEAT_TIMEOUT_MS);
    },
    dispose() {
      screen.off("display-added", rebuild);
      screen.off("display-removed", rebuild);
      screen.off("display-metrics-changed", rebuild);
      hide();
    },
  };
}

/** Wires the renderer heartbeat to one lazily created overlay (screen API needs app ready). */
export function registerScreenTakeoverOverlayIpc(options: {
  warn: (message: string) => void;
}): void {
  let overlay: ScreenTakeoverOverlay | undefined;
  ipcMain.on(PlatformChannels.SetScreenTakeoverOverlay, (_event, payload: unknown) => {
    const state = parseScreenTakeoverOverlayPayload(payload);
    if (!state.active && !overlay) return;
    overlay ??= createScreenTakeoverOverlay(options);
    overlay.update(state);
  });
}
