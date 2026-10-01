/**
 * ComputerFrameStream consumer contract (acevra-agent-computer.md §4.5).
 *
 * Source-independent: any producer (Dell worker, future local Mac ScreenCaptureKit workspace
 * backend, future cloud VM) that emits `StreamFrame` + `StreamCursor` events drives this. The
 * rules that make the pane feel alive:
 * - frames are strictly monotonic by `seq` — stale / out-of-order / duplicate frames are rejected;
 * - latest-frame semantics: the presenter holds ONE frame; a frame is never queued behind another;
 * - cursor updates are a separate lightweight stream, accepted even between frames;
 * - drop/latency counters are dev diagnostics, never product chrome.
 */

export interface StreamFrame {
  seq: number;
  /** Producer capture timestamp (epoch ms), if the source provides one. */
  capturedAt?: number;
}

export interface StreamCursor {
  seq: number;
  x: number;
  y: number;
}

export interface StreamCounters {
  /** Frames delivered to the presenter. */
  presented: number;
  /** Frames that lost the latest-frame race (stale/out-of-order/superseded). */
  dropped: number;
  cursorUpdates: number;
  /** Last capture→present latency in ms (when the source provides capturedAt). */
  lastLatencyMs: number | null;
}

export interface StreamState<F extends StreamFrame> {
  frame: F | null;
  cursor: StreamCursor | null;
  counters: StreamCounters;
}

export function createFrameStreamState<F extends StreamFrame>(): StreamState<F> {
  return {
    frame: null,
    cursor: null,
    counters: { presented: 0, dropped: 0, cursorUpdates: 0, lastLatencyMs: null },
  };
}

/** True when `next` is strictly newer than the currently presented frame. */
export function isNewerFrame(current: StreamFrame | null, next: StreamFrame): boolean {
  if (!Number.isFinite(next.seq)) return false;
  return current === null || next.seq > current.seq;
}

/**
 * Latest-frame admission. Returns the (possibly unchanged) frame to present plus the new state;
 * rejected frames count as dropped, never queued.
 */
export function acceptFrame<F extends StreamFrame>(
  state: StreamState<F>,
  next: F,
  now: number = Date.now(),
): StreamState<F> {
  if (!isNewerFrame(state.frame, next)) {
    return {
      ...state,
      counters: { ...state.counters, dropped: state.counters.dropped + 1 },
    };
  }
  const latency =
    typeof next.capturedAt === "number" && next.capturedAt > 0
      ? Math.max(0, now - next.capturedAt)
      : null;
  return {
    frame: next,
    cursor: state.cursor,
    counters: {
      ...state.counters,
      presented: state.counters.presented + 1,
      lastLatencyMs: latency !== null ? latency : state.counters.lastLatencyMs,
    },
  };
}

/** Cursor events are independent of frames; only the newest position matters. */
export function acceptCursor<F extends StreamFrame>(
  state: StreamState<F>,
  cursor: StreamCursor,
): StreamState<F> {
  return {
    frame: state.frame,
    cursor,
    counters: { ...state.counters, cursorUpdates: state.counters.cursorUpdates + 1 },
  };
}

/**
 * Dev-only fps/latency sampler (spec §4.5 metrics). `sample()` returns null until the window
 * closes; the caller decides where the numbers go (debug log, evidence) — never product chrome.
 */
export function createStreamSampler(nowFn: () => number = Date.now, windowMs = 10_000) {
  const now = nowFn;
  let windowStart = now();
  let frames = 0;
  let cursorUpdates = 0;
  let latencySum = 0;
  let latencyCount = 0;
  const latencies: number[] = [];
  return {
    onFrame(latencyMs: number | null) {
      frames += 1;
      if (latencyMs !== null) {
        latencySum += latencyMs;
        latencyCount += 1;
        latencies.push(latencyMs);
        if (latencies.length > 500) latencies.shift();
      }
    },
    onCursor() {
      cursorUpdates += 1;
    },
    sample(): {
      fps: number;
      cursorPerSec: number;
      latencyP50Ms: number | null;
      latencyP95Ms: number | null;
    } | null {
      const elapsed = now() - windowStart;
      if (elapsed < windowMs) return null;
      const p = (q: number) =>
        latencies.length
          ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]
          : null;
      const result = {
        fps: +((frames * 1000) / elapsed).toFixed(2),
        cursorPerSec: +((cursorUpdates * 1000) / elapsed).toFixed(1),
        latencyP50Ms: latencyCount ? Math.round(p(0.5)!) : null,
        latencyP95Ms: latencyCount ? Math.round(p(0.95)!) : null,
      };
      windowStart = now();
      frames = 0;
      cursorUpdates = 0;
      latencySum = 0;
      latencyCount = 0;
      latencies.length = 0;
      return result;
    },
  };
}
