/**
 * SSH computers runtime against a fake Dell worker (acevra-agent-computer.md §4–§5): the worker
 * stays the authority for job / lease / take-control; Main only correlates sessions, relays
 * frames to visible tabs and forwards human input while the worker reports human control.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { ComputerView, SshComputerConfig } from "@zcode/shared";
import { PANEL_CONTROLLER } from "./computerJob.js";
import { createComputersService } from "./computersService.js";
import type { SpawnFn } from "./sshCommand.js";
import type { SshComputersStore } from "./sshComputersStore.js";
import type { ViewSocket } from "./computerViewStream.js";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz";
const DELL: SshComputerConfig = { id: "dell", name: "Dell", hostAlias: "dell", workerPort: 8765 };

function fakeStore(): SshComputersStore {
  return {
    list: async () => [DELL],
    get: async (id: string) => (id === DELL.id ? DELL : null),
    add: async () => [DELL],
    remove: async () => [],
  } as unknown as SshComputersStore;
}

function fakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    kill: () => {
      (child as { exitCode: number | null }).exitCode = 0;
      setImmediate(() => child.emit("exit", 0));
      return true;
    },
  });
  return child;
}

function fakeSpawn(opts: { tunnelFails?: string } = {}) {
  const calls: string[][] = [];
  const spawn: SpawnFn = (_command, args) => {
    calls.push(args);
    const child = fakeChild();
    if (args.includes("-N")) {
      if (opts.tunnelFails) {
        setImmediate(() => {
          child.stderr?.emit("data", Buffer.from(opts.tunnelFails!));
          (child as { exitCode: number | null }).exitCode = 255;
          child.emit("exit", 255);
        });
      }
      return child;
    }
    setImmediate(() => {
      child.stdout?.emit("data", Buffer.from(`${TOKEN}\r\n`));
      child.emit("close", 0);
    });
    return child;
  };
  return { spawn, calls };
}

interface FakeJob {
  job_id: string;
  state: string;
  controller: string;
  yield?: { reason: string } | null;
}

function fakeWorker(opts: { unreachable?: boolean } = {}) {
  let job: FakeJob | null = null;
  let seq = 0;
  const requests: Array<{
    path: string;
    body: Record<string, any>;
    headers: Record<string, string>;
  }> = [];
  let reject401 = false;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    if (opts.unreachable) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    requests.push({ path: url.pathname, body, headers });
    if (url.pathname === "/health") return json(200, { ok: true, width: 1366, height: 768 });
    if (reject401 && url.pathname !== "/agent/job") {
      reject401 = false;
      return json(401, { detail: { code: "unauthorized", reason: "token" } });
    }
    if (headers["x-acevra-token"] !== TOKEN)
      return json(401, { detail: { code: "unauthorized", reason: "token" } });
    switch (url.pathname) {
      case "/agent/job":
        return json(200, job ?? { state: "idle" });
      case "/agent/attach":
        if (job) return json(409, { detail: { code: "busy", reason: "another_job_active" } });
        job = {
          job_id: `job-${++seq}`,
          state: "running",
          controller: body.controller,
          yield: null,
        };
        return json(200, { ok: true, job });
      case "/agent/heartbeat":
        return json(200, { ok: true });
      case "/agent/take-control":
        if (!job) return json(409, { detail: { code: "no_active_job", reason: "no_active_job" } });
        job = { ...job, state: "human_control" };
        return json(200, { ok: true, job });
      case "/agent/resume":
        if (job) job = { ...job, state: "running", yield: null };
        return json(200, { ok: true, job });
      case "/agent/stop":
        job = null;
        return json(200, { ok: true });
      case "/screen":
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
      default:
        if (!job || body.job_id !== job.job_id)
          return json(409, { detail: { code: "stale_job_id", reason: "stale_job_id" } });
        if (job.state !== "running" || job.yield)
          return json(409, {
            detail: { code: "paused", reason: job.yield?.reason ?? "human_control" },
          });
        return json(200, { ok: true });
    }
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    requests,
    setJob: (next: FakeJob | null) => {
      job = next;
    },
    job: () => job,
    rejectNext401: () => {
      reject401 = true;
    },
  };
}

class FakeSocket extends EventEmitter implements ViewSocket {
  readyState = 0;
  sent: Array<Record<string, any>> = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    super();
    setImmediate(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
  frame(seq: number) {
    this.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          t: "frame",
          seq,
          width: 960,
          height: 540,
          sw: 1366,
          sh: 768,
          cx: 10,
          cy: 20,
        }),
      ),
      false,
    );
    this.emit("message", Buffer.from([0xff, 0xd8, seq]), true);
  }
}

function setup(opts: { tunnelFails?: string } = {}) {
  const ssh = fakeSpawn(opts);
  const worker = fakeWorker({ unreachable: Boolean(opts.tunnelFails) });
  const sockets: FakeSocket[] = [];
  const views: ComputerView[] = [];
  const service = createComputersService({
    store: fakeStore(),
    spawn: ssh.spawn,
    fetch: worker.fetch,
    openSocket: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    encodeScreenshot: () => ({ base64: "AAAA", mimeType: "image/jpeg", width: 1366, height: 768 }),
    onView: (view) => views.push(view),
  });
  return { service, ssh, worker, sockets, views };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("first action attaches a session-owned job and reuses it afterwards", async (t) => {
  const { service, worker } = setup();
  t.after(() => service.dispose());
  const first = await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "click", x: 10, y: 20 },
  });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.sessionStarted, true);
  const attach = worker.requests.find((r) => r.path === "/agent/attach");
  assert.equal(attach?.body.controller, "acevra-mac:session:s1");
  const click = worker.requests.find((r) => r.path === "/click");
  assert.equal(click?.headers["x-acevra-actor"], "agent");
  assert.equal(click?.body.job_id, "job-1");

  const second = await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "screenshot" },
  });
  assert.equal(second.ok && second.sessionStarted, undefined);
  assert.equal(second.ok && second.image?.mimeType, "image/jpeg");
  assert.equal(worker.requests.filter((r) => r.path === "/agent/attach").length, 1);
});

test("another conversation is refused while a job is active; the user's panel job reads as user_in_control", async (t) => {
  const { service, worker } = setup();
  t.after(() => service.dispose());
  await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "move", x: 1, y: 1 },
  });
  const other = await service.computerAction({
    sessionId: "s2",
    targetId: "ssh:dell",
    action: { kind: "move", x: 1, y: 1 },
  });
  assert.deepEqual(other, { ok: false, reason: "computer_busy", detail: "another_job_active" });

  worker.setJob({ job_id: "job-9", state: "human_control", controller: PANEL_CONTROLLER });
  const blocked = await service.computerAction({
    sessionId: "s3",
    targetId: "ssh:dell",
    action: { kind: "move", x: 1, y: 1 },
  });
  assert.deepEqual(blocked, { ok: false, reason: "computer_busy", detail: "user_in_control" });
});

test("physical input yield on the worker surfaces as computer_paused", async (t) => {
  const { service, worker } = setup();
  t.after(() => service.dispose());
  await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "move", x: 1, y: 1 },
  });
  const current = worker.job();
  assert.ok(current);
  worker.setJob({ ...current, yield: { reason: "physical_input" } });
  const result = await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "type", text: "hi" },
  });
  assert.deepEqual(result, { ok: false, reason: "computer_paused", detail: "physical_input" });
  const view = await service.getView("dell");
  assert.equal(view?.control, "paused");
  assert.equal(view?.job?.yieldReason, "physical_input");
});

test("an expired lease re-attaches once instead of guessing on the Mac", async (t) => {
  const { service, worker } = setup();
  t.after(() => service.dispose());
  await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "move", x: 1, y: 1 },
  });
  worker.setJob(null);
  const result = await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "key", keys: ["ctrl", "s"] },
  });
  assert.equal(result.ok, true);
  assert.equal(worker.requests.filter((r) => r.path === "/agent/attach").length, 2);
  assert.deepEqual(worker.requests.find((r) => r.path === "/hotkey")?.body.keys, ["ctrl", "s"]);
});

test("offline computers fail truthfully with no local fallback", async (t) => {
  const { service, worker } = setup({
    tunnelFails: "ssh: connect to host dell port 22: Connection refused",
  });
  t.after(() => service.dispose());
  const result = await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "screenshot" },
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "computer_offline");
  assert.equal(!result.ok && result.detail, "unreachable");
  assert.equal(worker.requests.length, 0);
  const targets = await service.listTargets();
  assert.equal(targets[0]?.online, false);
});

test("take control with no job attaches a panel job; give back stops it", async (t) => {
  const { service, worker } = setup();
  t.after(() => service.dispose());
  assert.deepEqual(await service.takeControl("dell"), { ok: true });
  assert.equal(worker.job()?.controller, PANEL_CONTROLLER);
  assert.equal(worker.job()?.state, "human_control");
  assert.deepEqual(await service.giveBack("dell"), { ok: true });
  assert.equal(worker.job(), null);
  assert.ok(worker.requests.some((r) => r.path === "/agent/stop"));
});

test("give back during an agent job resumes the agent instead of stopping it", async (t) => {
  const { service, worker } = setup();
  t.after(() => service.dispose());
  await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "move", x: 1, y: 1 },
  });
  await service.takeControl("dell");
  assert.equal(worker.job()?.state, "human_control");
  await service.giveBack("dell");
  assert.equal(worker.job()?.state, "running");
  assert.ok(!worker.requests.some((r) => r.path === "/agent/stop"));
});

test("the view socket opens with the first viewer, forwards input only in human control, closes with the last", async (t) => {
  const { service, worker, sockets } = setup();
  t.after(() => service.dispose());
  const frames: number[] = [];
  const unsubscribe = service.subscribe("dell", {
    interactive: false,
    onFrame: (meta) => frames.push(meta.seq),
  });
  await until(() => sockets[0]?.readyState === 1, "socket open");
  const socket = sockets[0]!;
  assert.equal(socket.headers["x-acevra-token"], TOKEN);
  assert.ok(!socket.url.includes(TOKEN));
  assert.deepEqual(socket.sent[0], { t: "view", fps: 5, max_width: 960, quality: 60 });
  socket.frame(1);
  assert.deepEqual(frames, [1]);

  service.sendInput("dell", [{ kind: "text", text: "nope" }]);
  assert.equal(socket.sent.filter((m) => m.t === "input").length, 0);

  await service.takeControl("dell");
  await until(() => socket.sent.some((m) => m.t === "view" && m.fps === 15), "control profile");
  service.sendInput("dell", [{ kind: "text", text: "hi" }]);
  const input = socket.sent.find((m) => m.t === "input");
  assert.deepEqual(input, {
    t: "input",
    job_id: worker.job()?.job_id,
    ev: { kind: "text", text: "hi" },
  });

  unsubscribe();
  assert.equal(socket.closed, true);
  await tick(20);
  assert.equal(sockets.length, 1);
});

test("a rotated worker token is refetched once on 401", async (t) => {
  const { service, ssh, worker } = setup();
  t.after(() => service.dispose());
  await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "move", x: 1, y: 1 },
  });
  const tokenReads = () => ssh.calls.filter((args) => !args.includes("-N")).length;
  assert.equal(tokenReads(), 1);
  worker.rejectNext401();
  const result = await service.computerAction({
    sessionId: "s1",
    targetId: "ssh:dell",
    action: { kind: "click", x: 5, y: 5 },
  });
  assert.equal(result.ok, true);
  assert.equal(tokenReads(), 2);
});
