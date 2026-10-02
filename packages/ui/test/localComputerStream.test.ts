/**
 * LocalComputerPreview stream source: pure reducer over workspace_stream reads.
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/localComputerStream.test.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createLocalStreamState,
  localCursorPercent,
  reduceLocalStream,
} from "../src/computers/localComputerStream.js";

type Read = Parameters<typeof reduceLocalStream>[1];

const CHROME = { pid: 100, windowId: 1, app: "Google Chrome" };
const NOTES = { pid: 200, windowId: 2, app: "Notes" };

function read(overrides: Partial<Read> & { target?: typeof CHROME | null; cursor?: unknown } = {}) {
  const { target = CHROME, cursor, ...rest } = overrides;
  return {
    sourceId: "local-mac",
    executionTargetId: "this-device",
    status: "available",
    generation: "gen-chrome",
    paused: false,
    seq: 1,
    capturedAt: 1_000,
    jpeg: "Q0hST01F",
    pid: target?.pid,
    windowId: target?.windowId,
    originX: 100,
    originY: 50,
    pointWidth: 800,
    pointHeight: 600,
    workspace: {
      workspaceId: "w",
      backendId: "agent-workspace",
      state: "acting",
      framesCaptured: 0,
      updatedAt: 1,
      ...(target ? { target } : {}),
      ...(cursor ? { cursor } : {}),
    },
    ...rest,
  } as Read;
}

test("target window stream starts: first frame goes live with its source identity", () => {
  const state = reduceLocalStream(createLocalStreamState(), read(), 1_050);
  assert.equal(state.status, "live");
  assert.equal(state.identity, "gen-chrome:100:1");
  assert.equal(state.stream.frame?.seq, 1);
  assert.match(state.stream.frame?.url ?? "", /^data:image\/jpeg;base64,Q0hST01F$/);
  assert.equal(state.stream.counters.lastLatencyMs, 50);
  assert.equal(state.aspectRatio, 800 / 600);
});

test("latest-frame semantics: stale/duplicate seq never replaces the presented frame", () => {
  let state = reduceLocalStream(createLocalStreamState(), read({ seq: 5 }));
  state = reduceLocalStream(state, read({ seq: 4, jpeg: "T0xE" }));
  assert.equal(state.stream.frame?.seq, 5);
  assert.equal(state.stream.counters.dropped, 1);
  // afterSeq hit: the Helper omits bytes, the frame stays.
  state = reduceLocalStream(state, read({ seq: 5, jpeg: undefined }));
  assert.equal(state.stream.frame?.seq, 5);
  state = reduceLocalStream(state, read({ seq: 6, jpeg: "TkVX" }));
  assert.equal(state.stream.frame?.seq, 6);
});

test("target switch Chrome→Notes is fenced: no Chrome pixel survives once Notes is authoritative", () => {
  let state = reduceLocalStream(createLocalStreamState(), read({ seq: 40 }));
  state = reduceLocalStream(
    state,
    read({ target: NOTES, generation: "gen-notes", seq: 1, jpeg: "Tk9URVM=" }),
  );
  assert.equal(state.identity, "gen-notes:200:2");
  // seq restarts at 1 for the new generation and is still admitted (fresh source state).
  assert.equal(state.stream.frame?.seq, 1);
  assert.match(state.stream.frame?.url ?? "", /Tk9URVM=/);
  // A late Chrome read for the old generation is dropped as superseded by the adapter…
  const late = reduceLocalStream(state, { ...read({ seq: 41 }), reason: "superseded" } as Read);
  assert.equal(late, state);
  // …and the intermediate "waiting" read of the new target shows no frame at all.
  const waiting = reduceLocalStream(
    reduceLocalStream(createLocalStreamState(), read({ seq: 40 })),
    read({ target: NOTES, status: "unavailable", reason: "waiting_for_screen", jpeg: undefined }),
  );
  assert.equal(waiting.stream.frame, null);
  assert.equal(waiting.status, "waiting");
});

test("close/disappear clears the frame and reports unavailable", () => {
  let state = reduceLocalStream(createLocalStreamState(), read());
  state = reduceLocalStream(
    state,
    read({ status: "unavailable", reason: "target_lost", jpeg: undefined }),
  );
  assert.equal(state.stream.frame, null);
  assert.equal(state.cursor, null);
  assert.equal(state.status, "unavailable");
  const noTarget = reduceLocalStream(
    state,
    read({ target: null, status: "unavailable", reason: "target_unavailable", jpeg: undefined }),
  );
  assert.equal(noTarget.status, "waiting");
  assert.equal(noTarget.stream.frame, null);
});

test("cursor geometry: global AX points map into the captured window", () => {
  assert.deepEqual(
    localCursorPercent(
      { x: 500, y: 350 },
      { originX: 100, originY: 50, pointWidth: 800, pointHeight: 600 },
    ),
    { left: 50, top: 50 },
  );
  // Outside the window → hidden, never clamped onto an edge the agent did not touch.
  assert.equal(
    localCursorPercent(
      { x: 50, y: 350 },
      { originX: 100, originY: 50, pointWidth: 800, pointHeight: 600 },
    ),
    null,
  );
  assert.equal(localCursorPercent({ x: null, y: 1 }, { originX: 0 }), null);
});

test("cursor stays aligned across a window move/resize (geometry from the same read)", () => {
  let state = reduceLocalStream(
    createLocalStreamState(),
    read({ cursor: { x: 500, y: 350, updatedAt: 10 } }),
  );
  assert.deepEqual(state.cursor, { left: 50, top: 50, updatedAt: 10 });
  state = reduceLocalStream(
    state,
    read({
      seq: 2,
      originX: 300,
      originY: 50,
      pointWidth: 400,
      pointHeight: 600,
      cursor: { x: 500, y: 350, updatedAt: 10 },
    }),
  );
  assert.deepEqual(state.cursor, { left: 50, top: 50, updatedAt: 10 });
  assert.equal(state.aspectRatio, 400 / 600);
});

test("cursor ordering: an older cursor update never moves the cursor backwards", () => {
  let state = reduceLocalStream(
    createLocalStreamState(),
    read({ cursor: { x: 500, y: 350, updatedAt: 20 } }),
  );
  state = reduceLocalStream(state, read({ seq: 2, cursor: { x: 120, y: 60, updatedAt: 19 } }));
  assert.deepEqual(state.cursor, { left: 50, top: 50, updatedAt: 20 });
  state = reduceLocalStream(state, read({ seq: 3, cursor: { x: 180, y: 110, updatedAt: 21 } }));
  assert.deepEqual(state.cursor, { left: 10, top: 10, updatedAt: 21 });
});

test("target switch resets the cursor: Chrome's cursor never appears on Notes", () => {
  let state = reduceLocalStream(
    createLocalStreamState(),
    read({ cursor: { x: 500, y: 350, updatedAt: 30 } }),
  );
  assert.ok(state.cursor);
  // The projection cleared the cursor on target switch; Notes has none yet.
  state = reduceLocalStream(state, read({ target: NOTES, generation: "gen-notes", seq: 1 }));
  assert.equal(state.cursor, null);
});

test("preview source never touches the physical cursor, frontmost app, or Helper transport", async () => {
  for (const file of [
    "../src/computers/localComputerStream.ts",
    "../src/hooks/useLocalComputerStream.ts",
    "../src/v4/composer/MiniComputerPanel.tsx",
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    // Renderer reaches pixels only through the cuaPermissionService RPC; no direct Helper access.
    assert.doesNotMatch(source, /window\.zcode|host-transport|callMethod\(|workspace_stream"/);
    assert.doesNotMatch(source, /move_pointer|activate_target|acquire_control|take_control/);
    // The screen-scoped observation frame is not the local preview source.
    assert.doesNotMatch(source, /getComputerUseObservationFrame|preview\.dataUrl/);
  }
});
