/**
 * LocalComputerPreview floating-window geometry (computer-workspace.md "LocalComputerPreview
 * presentation"). Pure: bounds, aspect-preserving resize, centred expanded rect.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/localPreviewGeometry.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPreviewPosition,
  clampPreviewWidth,
  compactPreviewRect,
  expandedPreviewRect,
  frameHeightFor,
  PREVIEW_CHROME_HEIGHT,
  PREVIEW_EDGE_MARGIN,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MIN_WIDTH,
} from "../src/computers/localPreviewGeometry.js";

const VIEW = { width: 1440, height: 900 };

test("width is bounded; height follows the stream aspect (no distortion)", () => {
  assert.equal(clampPreviewWidth(10, VIEW), PREVIEW_MIN_WIDTH);
  assert.equal(clampPreviewWidth(5_000, VIEW), PREVIEW_MAX_WIDTH);
  assert.equal(
    clampPreviewWidth(5_000, { width: 500, height: 900 }),
    500 - PREVIEW_EDGE_MARGIN * 2,
  );
  assert.equal(frameHeightFor(400, 2), 200);
  assert.equal(frameHeightFor(400, null), 250, "fallback 16:10");
  assert.equal(frameHeightFor(400, 100), Math.round(400 / 3), "degenerate aspect is bounded");
});

test("position stays inside the app window with a margin, also after the window shrinks", () => {
  const size = { width: 352, height: 264 };
  assert.deepEqual(clampPreviewPosition({ x: -500, y: -20 }, size, VIEW), { x: 8, y: 8 });
  assert.deepEqual(clampPreviewPosition({ x: 5_000, y: 5_000 }, size, VIEW), {
    x: VIEW.width - size.width - 8,
    y: VIEW.height - size.height - 8,
  });
  const stored = compactPreviewRect({
    position: { x: 1_200, y: 700 },
    width: 352,
    aspectRatio: 1.6,
    viewport: { width: 1_000, height: 600 },
  });
  assert.ok(stored.x + stored.width <= 1_000 - 8);
  assert.ok(stored.y + stored.frameHeight + PREVIEW_CHROME_HEIGHT <= 600 - 8);
});

test("default compact rect sits just above the composer anchor, right-aligned", () => {
  const rect = compactPreviewRect({
    position: null,
    width: null,
    aspectRatio: 1.6,
    viewport: VIEW,
    anchor: { right: 1_300, top: 760 },
  });
  assert.equal(rect.x + rect.width, 1_300);
  assert.equal(rect.y + rect.frameHeight + PREVIEW_CHROME_HEIGHT, 760 - 8);
});

test("expanded rect is the largest aspect-correct frame that fits, centred", () => {
  const wide = expandedPreviewRect(16 / 9, VIEW);
  assert.ok(wide.width <= VIEW.width - 96);
  assert.ok(wide.frameHeight + PREVIEW_CHROME_HEIGHT <= VIEW.height - 160 + 1);
  assert.equal(Math.round(wide.width / wide.frameHeight), Math.round(16 / 9));
  assert.ok(Math.abs(wide.x - (VIEW.width - wide.width) / 2) <= 1);
  const tall = expandedPreviewRect(0.6, VIEW);
  assert.ok(tall.frameHeight + PREVIEW_CHROME_HEIGHT <= VIEW.height - 160 + 1);
  assert.ok(tall.width < wide.width);
});
