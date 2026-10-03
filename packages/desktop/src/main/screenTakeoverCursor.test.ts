// Agent cursor reticle (zcode-cua/specs/computer-use.md "Visible agent pointer").
import assert from "node:assert/strict";
import test from "node:test";

import {
  createTakeoverCursorFollower,
  TAKEOVER_CURSOR_SIZE,
  takeoverCursorHtml,
} from "./screenTakeoverCursor.js";

function harness(points: Array<{ x: number; y: number }>) {
  let index = 0;
  const moves: Array<[number, number]> = [];
  let tick: (() => void) | undefined;
  let cleared = 0;
  const follower = createTakeoverCursorFollower({
    size: 72,
    getCursorPoint: () => points[Math.min(index, points.length - 1)]!,
    moveTo: (x, y) => moves.push([x, y]),
    setIntervalFn: (callback) => {
      tick = callback;
      return 1;
    },
    clearIntervalFn: () => {
      cleared += 1;
    },
  });
  return {
    follower,
    moves,
    advance: () => {
      index += 1;
      tick?.();
    },
    get cleared() {
      return cleared;
    },
  };
}

test("the reticle is centred on the pointer and placed immediately on start", () => {
  const h = harness([{ x: 500.4, y: 300.6 }]);
  h.follower.start();
  assert.deepEqual(h.moves, [[464, 265]]);
});

test("the window moves only when the pointer does", () => {
  const h = harness([
    { x: 100, y: 100 },
    { x: 100, y: 100 },
    { x: 130, y: 90 },
    { x: 130, y: 90 },
  ]);
  h.follower.start();
  h.advance();
  h.advance();
  h.advance();
  assert.deepEqual(h.moves, [
    [64, 64],
    [94, 54],
  ]);
});

test("start and stop are idempotent and stop ends polling", () => {
  const h = harness([{ x: 10, y: 10 }]);
  h.follower.start();
  h.follower.start();
  assert.equal(h.follower.running, true);
  h.follower.stop();
  h.follower.stop();
  assert.equal(h.follower.running, false);
  assert.equal(h.cleared, 1);
});

test("a non-finite pointer reading is ignored", () => {
  const h = harness([{ x: Number.NaN, y: 4 }]);
  h.follower.start();
  assert.deepEqual(h.moves, []);
});

test("the reticle markup is script-free, honours Reduce Motion and never clips", () => {
  const html = takeoverCursorHtml();
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /prefers-reduced-motion:reduce/);
  // Pulse: 34 px ring scaled to 1.9 must stay inside the window.
  assert.ok(34 * 1.9 < TAKEOVER_CURSOR_SIZE);
  assert.match(html, /scale\(1\.9\)/);
});
