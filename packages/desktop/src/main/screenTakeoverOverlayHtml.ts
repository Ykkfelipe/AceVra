// Pure markup and payload parsing for the screen takeover glow (no Electron imports, unit-testable).

const MAX_TEXT = 120;
export const DEFAULT_LABEL = "AceVra is using your screen";
export const DEFAULT_HINT = "Press Esc or move the mouse to take back control";

export interface ScreenTakeoverOverlayUpdate {
  active: boolean;
  label?: string;
  hint?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : fallback;
}

/** Parses an untrusted IPC payload; anything malformed means "hide". */
export function parseScreenTakeoverOverlayPayload(payload: unknown): ScreenTakeoverOverlayUpdate {
  if (!payload || typeof payload !== "object") return { active: false };
  const record = payload as Record<string, unknown>;
  return {
    active: record.active === true,
    label: cleanText(record.label, DEFAULT_LABEL),
    hint: cleanText(record.hint, DEFAULT_HINT),
  };
}

export function screenTakeoverOverlayHtml(options: {
  withPill: boolean;
  label: string;
  hint: string;
}): string {
  const pill = options.withPill
    ? `<div class="pill"><span class="dot"></span><strong>${escapeHtml(options.label)}</strong><span class="hint">${escapeHtml(options.hint)}</span></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;cursor:default;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.glow{position:fixed;inset:0;pointer-events:none;
  box-shadow:inset 0 0 0 3px rgba(122,162,255,.95),inset 0 0 26px 8px rgba(122,162,255,.55),
    inset 0 0 90px 26px rgba(168,124,255,.28);
  animation:pulse 2.4s ease-in-out infinite}
.pill{position:fixed;top:40px;left:50%;transform:translateX(-50%);display:flex;gap:10px;
  align-items:center;padding:8px 16px;border-radius:999px;white-space:nowrap;font-size:13px;
  color:#fff;background:rgba(18,18,26,.84);border:1px solid rgba(140,170,255,.65);
  box-shadow:0 6px 22px rgba(0,0,0,.35),0 0 18px rgba(122,162,255,.35)}
.hint{opacity:.72}
.dot{width:8px;height:8px;border-radius:50%;background:#7aa2ff;box-shadow:0 0 10px #7aa2ff;
  animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.6}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.glow,.dot{animation:none}}
</style></head><body><div class="glow"></div>${pill}</body></html>`;
}
