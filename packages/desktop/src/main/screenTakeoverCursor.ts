// Agent cursor reticle (zcode-cua/specs/computer-use.md "Visible agent pointer"): a small
// presentation-only overlay centred on the real pointer while the takeover glow is shown.
//
// Pure pieces only (no Electron import) so the follow loop and markup are testable; the window
// itself is owned by screenTakeoverOverlay.ts with the same rules as the glow.

/** Reticle window edge in points; the outward pulse peaks at ~65 px, so it never clips. */
export const TAKEOVER_CURSOR_SIZE = 72;
/** ~60 Hz: matches the Helper's 15 ms glide steps without measurable cost. */
export const TAKEOVER_CURSOR_FOLLOW_INTERVAL_MS = 16;

export interface CursorPoint {
  x: number;
  y: number;
}

/**
 * Follows the pointer while started. Moves the window only when the rounded origin changes, so an
 * idle pointer costs one cheap cursor read per tick and no window work.
 */
export function createTakeoverCursorFollower(deps: {
  size: number;
  getCursorPoint: () => CursorPoint;
  moveTo: (x: number, y: number) => void;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}) {
  const intervalMs = deps.intervalMs ?? TAKEOVER_CURSOR_FOLLOW_INTERVAL_MS;
  const setIntervalFn = deps.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn =
    deps.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let handle: unknown = null;
  let lastOrigin: string | null = null;
  const tick = () => {
    const point = deps.getCursorPoint();
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const x = Math.round(point.x - deps.size / 2);
    const y = Math.round(point.y - deps.size / 2);
    const origin = `${x},${y}`;
    if (origin === lastOrigin) return;
    lastOrigin = origin;
    deps.moveTo(x, y);
  };
  return {
    start(): void {
      if (handle !== null) return;
      tick();
      handle = setIntervalFn(tick, intervalMs);
    },
    stop(): void {
      if (handle === null) return;
      clearIntervalFn(handle);
      handle = null;
      lastOrigin = null;
    },
    get running(): boolean {
      return handle !== null;
    },
  };
}

/**
 * Reticle markup in the glow's palette. CSS transform/opacity animation only (compositor, no
 * script); Reduce Motion freezes the arc and drops the pulse.
 */
export function takeoverCursorHtml(): string {
  const tick = (deg: number) =>
    `<i class="tick" style="transform:rotate(${deg}deg) translateY(-27px)"></i>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
.r{position:absolute;inset:0;display:grid;place-items:center}
.r>*{grid-area:1/1}
.halo{width:46px;height:46px;border-radius:50%;
  background:radial-gradient(circle,rgba(122,162,255,.30) 0%,rgba(168,124,255,.14) 45%,transparent 70%)}
.ring{width:34px;height:34px;border-radius:50%;box-sizing:border-box;
  border:1.5px solid rgba(122,162,255,.6);box-shadow:0 0 10px rgba(122,162,255,.5)}
.arc{width:46px;height:46px;border-radius:50%;
  background:conic-gradient(from 0deg,transparent 0 58%,#7aa2ff 80%,#a87cff 100%);
  -webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));
  animation:spin 1.8s linear infinite}
.tick{display:block;width:2px;height:7px;border-radius:1px;background:#d6e2ff;
  box-shadow:0 0 6px #7aa2ff}
.core{width:5px;height:5px;border-radius:50%;background:#fff;box-shadow:0 0 8px 2px #7aa2ff}
.pulse{width:34px;height:34px;border-radius:50%;box-sizing:border-box;
  border:1.5px solid rgba(168,124,255,.7);animation:pulse 1.8s ease-out infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%{transform:scale(.85);opacity:.8}100%{transform:scale(1.9);opacity:0}}
@media (prefers-reduced-motion:reduce){.arc{animation:none}.pulse{display:none}}
</style></head><body><div class="r"><div class="halo"></div><div class="pulse"></div>
<div class="ring"></div><div class="arc"></div>${[0, 90, 180, 270].map(tick).join("")}
<div class="core"></div></div></body></html>`;
}
