/**
 * LocalComputerPreview window geometry (computer-workspace.md "LocalComputerPreview presentation").
 * Pure functions: the presentation store keeps the inputs, the panel renders the outputs.
 */

export interface Viewport {
  width: number;
  height: number;
}

export interface PreviewPoint {
  x: number;
  y: number;
}

export interface PreviewRect extends PreviewPoint {
  width: number;
  /** Live-frame height (the title bar is added on top of it). */
  frameHeight: number;
}

export const PREVIEW_EDGE_MARGIN = 8;
/** Title bar height in px (two text lines + padding). */
export const PREVIEW_CHROME_HEIGHT = 44;
export const PREVIEW_MIN_WIDTH = 260;
export const PREVIEW_MAX_WIDTH = 640;
export const PREVIEW_DEFAULT_WIDTH = 352;
const FALLBACK_ASPECT = 16 / 10;
const EXPANDED_SIDE_GUTTER = 48;
const EXPANDED_VERTICAL_GUTTER = 80;

/** Stream aspect ratio, bounded so a degenerate window cannot produce an absurd panel. */
export function previewAspect(aspectRatio: number | null | undefined): number {
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return FALLBACK_ASPECT;
  return Math.min(3, Math.max(0.5, aspectRatio));
}

export function maxCompactWidth(viewport: Viewport): number {
  return Math.max(
    PREVIEW_MIN_WIDTH,
    Math.min(PREVIEW_MAX_WIDTH, viewport.width - PREVIEW_EDGE_MARGIN * 2),
  );
}

/** Width bounded to [min, max]; NaN or missing → default. */
export function clampPreviewWidth(width: number | null | undefined, viewport: Viewport): number {
  const value = width && Number.isFinite(width) ? width : PREVIEW_DEFAULT_WIDTH;
  return Math.round(Math.min(maxCompactWidth(viewport), Math.max(PREVIEW_MIN_WIDTH, value)));
}

export function frameHeightFor(width: number, aspectRatio: number | null | undefined): number {
  return Math.round(width / previewAspect(aspectRatio));
}

/** Keeps the whole panel inside the app window with a small margin. */
export function clampPreviewPosition(
  position: PreviewPoint,
  size: { width: number; height: number },
  viewport: Viewport,
): PreviewPoint {
  const maxX = Math.max(PREVIEW_EDGE_MARGIN, viewport.width - size.width - PREVIEW_EDGE_MARGIN);
  const maxY = Math.max(PREVIEW_EDGE_MARGIN, viewport.height - size.height - PREVIEW_EDGE_MARGIN);
  return {
    x: Math.round(Math.min(maxX, Math.max(PREVIEW_EDGE_MARGIN, position.x))),
    y: Math.round(Math.min(maxY, Math.max(PREVIEW_EDGE_MARGIN, position.y))),
  };
}

/**
 * Compact rect: stored position/width when present, else the default anchor (bottom-right of
 * `anchor`, i.e. just above the composer). Always clamped to the current window.
 */
export function compactPreviewRect(input: {
  position: PreviewPoint | null;
  width: number | null;
  aspectRatio: number | null | undefined;
  viewport: Viewport;
  anchor?: { right: number; top: number } | null;
}): PreviewRect {
  const width = clampPreviewWidth(input.width, input.viewport);
  const frameHeight = frameHeightFor(width, input.aspectRatio);
  const height = frameHeight + PREVIEW_CHROME_HEIGHT;
  const fallback = input.anchor
    ? { x: input.anchor.right - width, y: input.anchor.top - height - PREVIEW_EDGE_MARGIN }
    : {
        x: input.viewport.width - width - 24,
        y: input.viewport.height - height - 160,
      };
  const position = clampPreviewPosition(
    input.position ?? fallback,
    { width, height },
    input.viewport,
  );
  return { ...position, width, frameHeight };
}

/** Expanded rect: largest aspect-correct frame that fits the window, centred. */
export function expandedPreviewRect(
  aspectRatio: number | null | undefined,
  viewport: Viewport,
): PreviewRect {
  const aspect = previewAspect(aspectRatio);
  const maxWidth = Math.max(PREVIEW_MIN_WIDTH, viewport.width - EXPANDED_SIDE_GUTTER * 2);
  const maxFrameHeight = Math.max(
    120,
    viewport.height - EXPANDED_VERTICAL_GUTTER * 2 - PREVIEW_CHROME_HEIGHT,
  );
  const width = Math.round(
    Math.max(PREVIEW_MIN_WIDTH, Math.min(maxWidth, maxFrameHeight * aspect)),
  );
  const frameHeight = frameHeightFor(width, aspect);
  const height = frameHeight + PREVIEW_CHROME_HEIGHT;
  return {
    x: Math.round(Math.max(PREVIEW_EDGE_MARGIN, (viewport.width - width) / 2)),
    y: Math.round(Math.max(PREVIEW_EDGE_MARGIN, (viewport.height - height) / 2)),
    width,
    frameHeight,
  };
}
