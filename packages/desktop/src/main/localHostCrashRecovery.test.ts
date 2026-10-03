// Local Host crash recovery (specs/desktop-host-unification.md "Local Host crash recovery").
// Fakes only: fake utility processes, a fake renderer whose reload re-runs dom-ready → spawn.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createLocalHostCrashRecovery,
  createLocalHostSupervisor,
  createRendererCrashSupervisor,
} from "./localHostCrashRecovery.js";

class FakeHost extends EventEmitter {
  alive = true;
  constructor(readonly id: number) {
    super();
  }
  /** Commands are served only while the process lives. */
  handle(command: string): string {
    if (!this.alive) throw new Error("host connection is gone");
    return `host-${this.id}:${command}`;
  }
  crash(code = 1): void {
    this.alive = false;
    this.emit("exit", code);
  }
}

/** A renderer page load binds exactly one service port (one host generation). */
function fakeWindow() {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const disposing = new Set<FakeHost>();
  const hosts: FakeHost[] = [];
  let alive = true;
  let forceQuit = false;
  let port: { host: FakeHost; generation: number } | null = null;
  let exhaustedRetry: (() => void) | null = null;
  const supervisor = createLocalHostSupervisor<FakeHost>({
    policy: createLocalHostCrashRecovery({ now: () => clock }),
    isIntentional: (host) => forceQuit || disposing.has(host),
    isWindowAlive: () => alive,
    recover: () => domReady(),
    onExhausted: (retry) => {
      exhaustedRetry = retry;
    },
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    cancel: () => undefined,
  });
  let clock = 0;
  const domReady = () => {
    const host = new FakeHost(hosts.length + 1);
    hosts.push(host);
    const generation = supervisor.adopt(host);
    port = { host, generation };
  };
  domReady();
  return {
    supervisor,
    hosts,
    scheduled,
    disposing,
    get port() {
      return port!;
    },
    get exhaustedRetry() {
      return exhaustedRetry;
    },
    send: (command: string, viaPort = port!) => viaPort.host.handle(command),
    runScheduled() {
      for (const job of scheduled.splice(0)) job.callback();
    },
    advance(ms: number) {
      clock += ms;
    },
    close() {
      alive = false;
    },
    quit() {
      forceQuit = true;
    },
  };
}

test("crash → exit observed → replacement host → new generation → old port fenced → new command succeeds", () => {
  const w = fakeWindow();
  const oldPort = w.port;
  assert.equal(w.send("stop"), "host-1:stop");
  w.hosts[0]!.crash();
  assert.equal(w.supervisor.current, null);
  assert.deepEqual(
    w.scheduled.map((job) => job.delayMs),
    [500],
  );
  w.runScheduled();
  assert.equal(w.hosts.length, 2, "replacement host started");
  assert.equal(w.supervisor.generation, 2);
  assert.notEqual(w.port.generation, oldPort.generation);
  assert.throws(() => w.send("stop", oldPort), /gone/, "dead generation never serves commands");
  assert.equal(w.send("stop"), "host-2:stop", "new command reaches the replacement");
});

test("repeated crashes back off and stop after the budget; an explicit retry resets it", () => {
  const w = fakeWindow();
  const delays: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    w.hosts.at(-1)!.crash();
    delays.push(...w.scheduled.map((job) => job.delayMs));
    w.runScheduled();
    w.advance(1_000);
  }
  assert.deepEqual(delays, [500, 2_000, 8_000]);
  assert.equal(w.hosts.length, 4);
  w.hosts.at(-1)!.crash();
  assert.equal(w.scheduled.length, 0, "no fourth restart inside the window: no restart loop");
  assert.equal(w.hosts.length, 4);
  assert.ok(w.exhaustedRetry, "the user is told and offered a retry");
  w.exhaustedRetry!();
  assert.equal(w.hosts.length, 5, "retry restarts once with a fresh budget");
  w.hosts.at(-1)!.crash();
  assert.deepEqual(
    w.scheduled.map((job) => job.delayMs),
    [500],
  );
});

test("crashes outside the window do not exhaust the budget", () => {
  const w = fakeWindow();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    w.hosts.at(-1)!.crash();
    assert.deepEqual(
      w.scheduled.map((job) => job.delayMs),
      [500],
    );
    w.runScheduled();
    w.advance(200_000);
  }
  assert.equal(w.hosts.length, 6);
});

test("intentional shutdown, app quit and a closed window never respawn", () => {
  const disposed = fakeWindow();
  disposed.disposing.add(disposed.hosts[0]!);
  disposed.hosts[0]!.crash(0);
  assert.equal(disposed.scheduled.length, 0);

  const quitting = fakeWindow();
  quitting.quit();
  quitting.hosts[0]!.crash(0);
  assert.equal(quitting.scheduled.length, 0);

  const closed = fakeWindow();
  closed.close();
  closed.hosts[0]!.crash();
  assert.equal(closed.scheduled.length, 0);
  assert.equal(closed.hosts.length, 1);
});

test("a superseded host exiting after its replacement is adopted does not trigger another restart", () => {
  const w = fakeWindow();
  const first = w.hosts[0]!;
  w.hosts[0]!.crash();
  w.runScheduled();
  assert.equal(w.hosts.length, 2);
  first.emit("exit", 1); // late duplicate exit from the old generation
  assert.equal(w.scheduled.length, 0);
});

test("a manual reload during the backoff wins; the pending crash restart does nothing", () => {
  const w = fakeWindow();
  w.hosts[0]!.crash();
  // 用户在退避期间手动刷新：新 host 已被 adopt。
  w.supervisor.adopt(new FakeHost(99));
  w.runScheduled();
  assert.equal(w.hosts.length, 1, "no extra spawn from the stale crash timer");
});

// Renderer crash recovery (specs/desktop-host-unification.md "Renderer crash recovery and host
// stdio"): 2026-10-02 实测外部 kill 掉主窗口 renderer 后窗口沦为空壳、host 仍在运行。
function rendererHarness(overrides: { forceQuitting?: () => boolean } = {}) {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let reloads = 0;
  let windowAlive = true;
  const logs: string[] = [];
  const supervisor = createRendererCrashSupervisor({
    policy: createLocalHostCrashRecovery({ now: () => 0 }),
    isForceQuitting: overrides.forceQuitting ?? (() => false),
    isWindowAlive: () => windowAlive,
    reload: () => {
      reloads += 1;
    },
    log: (message) => logs.push(message),
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length;
    },
    cancel: () => undefined,
  });
  return {
    supervisor,
    scheduled,
    logs,
    get reloads() {
      return reloads;
    },
    closeWindow: () => {
      windowAlive = false;
    },
  };
}

test("a killed renderer is reloaded after backoff, reattaching the live host", () => {
  const h = rendererHarness();
  h.supervisor.onRendererGone("killed");
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]?.delayMs, 500);
  h.scheduled[0]?.callback();
  assert.equal(h.reloads, 1);
});

test("renderer reloads are bounded and then give up", () => {
  const h = rendererHarness();
  for (let i = 0; i < 4; i += 1) h.supervisor.onRendererGone("crashed");
  assert.deepEqual(
    h.scheduled.map((entry) => entry.delayMs),
    [500, 2_000, 8_000],
  );
  assert.ok(
    h.logs.some((line) => line.includes("not reloading")),
    h.logs.join("\n"),
  );
});

test("clean exits, non-recoverable reasons and force-quit never reload", () => {
  for (const reason of ["clean-exit", "launch-failed", "integrity-failure"]) {
    const h = rendererHarness();
    h.supervisor.onRendererGone(reason);
    assert.equal(h.scheduled.length, 0, reason);
  }
  const quitting = rendererHarness({ forceQuitting: () => true });
  quitting.supervisor.onRendererGone("killed");
  assert.equal(quitting.scheduled.length, 0);
});

test("a window closed during the backoff is not reloaded", () => {
  const h = rendererHarness();
  h.supervisor.onRendererGone("oom");
  h.closeWindow();
  h.scheduled[0]?.callback();
  assert.equal(h.reloads, 0);
});
