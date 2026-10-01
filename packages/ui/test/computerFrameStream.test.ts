/** ComputerFrameStream consumer contract (acevra-agent-computer.md §4.5): latest-frame
 * semantics, stale/out-of-order rejection, cursor ordering, bounded dev metrics. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptCursor,
  acceptFrame,
  createFrameStreamState,
  createStreamSampler,
  isNewerFrame,
} from "../src/computers/computerFrameStream.js";

test("frames are strictly monotonic: stale, duplicate and out-of-order frames are rejected", () => {
  let state = createFrameStreamState();
  state = acceptFrame(state, { seq: 5 });
  state = acceptFrame(state, { seq: 6 });
  // stale
  state = acceptFrame(state, { seq: 4 });
  assert.equal(state.frame?.seq, 6);
  assert.equal(state.counters.dropped, 1);
  // duplicate
  state = acceptFrame(state, { seq: 6 });
  assert.equal(state.counters.dropped, 2);
  // newest wins
  state = acceptFrame(state, { seq: 9 });
  assert.equal(state.frame?.seq, 9);
  assert.equal(state.counters.presented, 3);
});

test("rejected frames are never queued: presenter holds exactly one frame", () => {
  let state = createFrameStreamState();
  for (const seq of [1, 2, 3]) state = acceptFrame(state, { seq });
  assert.equal(state.frame?.seq, 3);
  state = acceptFrame(state, { seq: 2 });
  state = acceptFrame(state, { seq: 1 });
  assert.equal(state.frame?.seq, 3);
  assert.equal(state.counters.presented, 3);
});

test("non-finite seq is rejected", () => {
  let state = createFrameStreamState();
  state = acceptFrame(state, { seq: Number.NaN });
  assert.equal(state.frame, null);
  assert.equal(isNewerFrame(null, { seq: Number.NaN }), false);
});

test("cursor events are independent of frames and last-write-wins", () => {
  let state = createFrameStreamState();
  state = acceptCursor(state, { seq: 1, x: 10, y: 10 });
  state = acceptCursor(state, { seq: 1, x: 12, y: 14 });
  assert.deepEqual(state.cursor, { seq: 1, x: 12, y: 14 });
  assert.equal(state.counters.cursorUpdates, 2);
  // cursor does not disturb frame state
  state = acceptFrame(state, { seq: 2, capturedAt: 1000 });
  assert.equal(state.frame?.seq, 2);
  assert.deepEqual(state.cursor, { seq: 1, x: 12, y: 14 });
});

test("capture→present latency is recorded from capturedAt", () => {
  let state = createFrameStreamState();
  state = acceptFrame(state, { seq: 1, capturedAt: 5_000 }, 5_120);
  assert.equal(state.counters.lastLatencyMs, 120);
  state = acceptFrame(state, { seq: 2 }, 5_300);
  assert.equal(state.counters.lastLatencyMs, 120);
});

test("sampler reports fps, cursor rate and p50/p95 latency per window", () => {
  let t = 0;
  const sampler = createStreamSampler(() => t, 1_000);
  for (let i = 0; i < 10; i++) {
    t += 90; // ≈11 fps
    sampler.onFrame(40 + i);
  }
  for (let i = 0; i < 24; i++) sampler.onCursor();
  assert.equal(sampler.sample(), null);
  t += 101;
  const result = sampler.sample();
  assert.ok(result);
  assert.ok(Math.abs(result.fps - 10) < 0.1);
  assert.ok(result.latencyP50Ms! >= 40 && result.latencyP50Ms! <= 49);
  assert.ok(result.latencyP95Ms! >= 48 && result.latencyP95Ms! <= 49);
  // window resets
  assert.equal(sampler.sample(), null);
});
