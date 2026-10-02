import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createWorkspaceStreamAdapter,
  createWorkspaceStreamHelperCall,
} from "../src/cua-permission-broker/cuaWorkspaceStream.js";
import type { CuaWorkspaceView } from "@zcode/zcode-cua/broker";
function setup() {
  let workspace: CuaWorkspaceView | undefined = {
    workspaceId: "w",
    backendId: "agent-workspace",
    state: "idle",
    target: { pid: 10, windowId: 20 },
    framesCaptured: 4,
    updatedAt: 1,
  };
  const calls: Record<string, unknown>[] = [];
  const paused = false;
  let respond: (p: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({
    status: "available",
    seq: 1,
    jpeg: "eA==",
    width: 100,
    height: 50,
    pid: 10,
    windowId: 20,
  });
  const read = createWorkspaceStreamAdapter({
    workspace: () => workspace,
    paused: () => paused,
    call: async (p) => {
      calls.push(p);
      return respond(p);
    },
  });
  return {
    read,
    calls,
    setTarget: (v: CuaWorkspaceView | undefined) => {
      workspace = v;
    },
    setRespond: (f: typeof respond) => {
      respond = f;
    },
    get workspace() {
      return workspace;
    },
  };
}
test("source identity and human frames never create observations", async () => {
  const s = setup();
  const r = await s.read("session", { operation: "read" });
  assert.equal(r.sourceId, "local-mac");
  assert.equal(r.executionTargetId, "this-device");
  assert.equal(r.seq, 1);
  assert.equal(r.workspace?.framesCaptured, 4);
  assert.deepEqual(
    s.calls.map((p) => p.operation),
    ["read"],
  );
});
test("freshness threshold travels to capture without confirming an action", async () => {
  const s = setup();
  const r = await s.read("session", { operation: "read", afterSeq: 7 });
  assert.equal(s.calls[0].after_seq, 7);
  assert.equal(r.workspace?.action, undefined);
});
test("only one read is in flight; a slow consumer never creates a capture request backlog", async () => {
  const s = setup();
  let done!: (v: Record<string, unknown>) => void;
  s.setRespond(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const first = s.read("session", { operation: "read" });
  const second = await s.read("session", { operation: "read" });
  assert.equal(second.reason, "read_pending");
  assert.equal(s.calls.length, 1);
  done({ status: "available", seq: 4, pid: 10, windowId: 20 });
  assert.equal((await first).seq, 4);
});
test("late target A pixels cannot escape after target B is selected", async () => {
  const s = setup();
  let done!: (v: Record<string, unknown>) => void;
  s.setRespond(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const first = s.read("session", { operation: "read" });
  s.setTarget({ ...s.workspace!, target: { pid: 11, windowId: 21 } });
  await s.read("session", { operation: "read" });
  done({ status: "available", jpeg: "old" });
  const r = await first;
  assert.equal(r.reason, "superseded");
  assert.equal(r.jpeg, undefined);
});
test("target disappearance stops capture and clears pixels", async () => {
  const s = setup();
  await s.read("session", { operation: "read" });
  s.setTarget(undefined);
  const r = await s.read("session", { operation: "read" });
  assert.equal(r.reason, "target_unavailable");
  assert.equal(r.jpeg, undefined);
  assert.equal(s.calls.at(-1)?.operation, "stop");
});
test("hidden viewer stops its generation, another session cannot stop it", async () => {
  const s = setup();
  const initial = await s.read("session", { operation: "read" });
  await s.read("other", { operation: "stop" });
  assert.equal(s.calls.length, 1);
  await s.read("session", { operation: "stop" });
  assert.equal(s.calls.at(-1)?.generation, initial.generation);
});
test("capture failure truthfully reports unavailable without cached pixels", async () => {
  const s = setup();
  s.setRespond(async () => {
    throw new Error("disconnected");
  });
  const r = await s.read("session", { operation: "read" });
  assert.equal(r.reason, "capture_unavailable");
  assert.equal(r.jpeg, undefined);
});
test("wrong target pixels are refused even when the transport reports success", async () => {
  const s = setup();
  s.setRespond(async () => ({ status: "available", pid: 11, windowId: 20, jpeg: "old" }));
  const r = await s.read("session", { operation: "read" });
  assert.equal(r.reason, "wrong_target");
  assert.equal(r.jpeg, undefined);
});
test("hide and reopen renews the visual generation", async () => {
  const s = setup();
  const first = await s.read("session", { operation: "read" });
  await s.read("session", { operation: "stop" });
  assert.equal(s.calls.at(-1)?.operation, "stop");
  const reopened = await s.read("session", { operation: "read" });
  assert.notEqual(first.generation, reopened.generation);
});
test("local has no Take control: unknown operations never reach the Helper", async () => {
  const s = setup();
  for (const operation of ["take_control", "give_back", "stop_agent"]) {
    const r = await s.read("session", { operation } as never);
    assert.equal(r.reason, "bad_request");
  }
  assert.equal(s.calls.length, 0);
});
test("target switch Chrome→Notes fences the old generation and starts a fresh one", async () => {
  const s = setup();
  const chrome = await s.read("session", { operation: "read" });
  s.setTarget({ ...s.workspace!, target: { pid: 11, windowId: 21, app: "Notes" } });
  s.setRespond(async () => ({ status: "available", seq: 1, pid: 11, windowId: 21, jpeg: "bg==" }));
  const notes = await s.read("session", { operation: "read" });
  assert.notEqual(notes.generation, chrome.generation);
  assert.equal(notes.pid, 11);
  assert.equal(s.calls.at(-1)?.pid, 11);
  assert.equal(s.calls.at(-1)?.generation, notes.generation);
});
test("cursor and pixels come from the same read: projection is re-read after capture", async () => {
  const s = setup();
  s.setRespond(async () => {
    s.setTarget({ ...s.workspace!, cursor: { x: 120, y: 80, updatedAt: 9 } });
    return { status: "available", seq: 2, pid: 10, windowId: 20, originX: 100, originY: 50 };
  });
  const r = await s.read("session", { operation: "read" });
  assert.deepEqual(r.workspace?.cursor, { x: 120, y: 80, updatedAt: 9 });
  assert.equal(r.originX, 100);
});

const nodeSource = await readFile(new URL("../src/node.ts", import.meta.url), "utf8");

function hardenedHolder(connected: boolean, calls: unknown[][]) {
  return {
    host: {
      helperConnected: connected,
      callMethod: async (
        method: string,
        params: Record<string, unknown>,
        options?: { timeoutMs?: number },
      ) => {
        calls.push([method, params, options]);
        return { status: "available", seq: 1 };
      },
    },
  };
}
test("stream reads use the hardened session that owns the Helper in this Local Host", async () => {
  const calls: unknown[][] = [];
  let managedCalled = false;
  const call = createWorkspaceStreamHelperCall({
    hardened: () => hardenedHolder(true, calls),
    managed: () => ({
      queryWorkspaceStream: async () => {
        managedCalled = true;
        return {};
      },
    }),
  });
  const result = await call({ operation: "read", generation: "g" });
  assert.equal(result.status, "available");
  assert.equal(calls[0]?.[0], "workspace_stream");
  assert.deepEqual(calls[0]?.[2], { timeoutMs: 3_000 });
  assert.equal(managedCalled, false);
});
test("an empty managed lifecycle (darwin product) no longer makes the stream fail", async () => {
  const calls: unknown[][] = [];
  const call = createWorkspaceStreamHelperCall({
    hardened: () => hardenedHolder(true, calls),
    managed: () => undefined,
  });
  assert.equal((await call({ operation: "read" })).status, "available");
});
test("a disconnected Helper fails closed instead of starting a second Helper", async () => {
  const calls: unknown[][] = [];
  const call = createWorkspaceStreamHelperCall({
    hardened: () => hardenedHolder(false, calls),
    managed: () => undefined,
  });
  await assert.rejects(call({ operation: "read" }), /unavailable/);
  assert.equal(calls.length, 0);
});
test("node.ts wires the stream through the hardened session, not only the managed peek", () => {
  const start = nodeSource.indexOf("const workspaceStream = createWorkspaceStreamAdapter(");
  const end = nodeSource.indexOf("const cuaPermissionService", start);
  const wiring = nodeSource.slice(start, end);
  assert.match(wiring, /createWorkspaceStreamHelperCall\(/);
  assert.match(wiring, /hardened: \(\) => peekHardenedCuaHelperSession\(\)/);
  assert.doesNotMatch(wiring, /take_control|stopGeneration/);
});
