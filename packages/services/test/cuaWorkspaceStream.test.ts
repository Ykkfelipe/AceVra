import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceStreamAdapter } from "../src/cua-permission-broker/cuaWorkspaceStream.js";
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
  let paused = false;
  const stopEvents: string[] = [];
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
    pause: async () => {
      paused = true;
      stopEvents.push("pause");
    },
    resume: async () => {
      paused = false;
    },
    stop: async (sessionId) => {
      stopEvents.push(`stop:${sessionId}`);
    },
    call: async (p) => {
      calls.push(p);
      return respond(p);
    },
  });
  return {
    read,
    calls,
    stopEvents,
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
test("Take control pauses first and Give back resumes without an agent foreground lease", async () => {
  const s = setup();
  const r = await s.read("session", { operation: "take_control" });
  assert.equal(r.paused, true);
  assert.equal(r.userControl, true);
  assert.equal(s.calls[0].operation, "take_control");
  const back = await s.read("session", { operation: "give_back" });
  assert.equal(back.paused, false);
  assert.equal(back.userControl, false);
  assert.equal(s.calls.length, 1);
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
test("hide and reopen renews the visual generation while retaining explicit human control", async () => {
  const s = setup();
  const first = await s.read("session", { operation: "take_control" });
  await s.read("session", { operation: "stop" });
  const reopened = await s.read("session", { operation: "read" });
  assert.notEqual(first.generation, reopened.generation);
  assert.equal(reopened.userControl, true);
  assert.equal(reopened.paused, true);
});
test("Stop blocks admission before stopping the owning chat turn", async () => {
  const s = setup();
  const r = await s.read("session", { operation: "stop_agent" });
  assert.equal(r.paused, true);
  assert.deepEqual(s.stopEvents, ["pause", "stop:session"]);
});
