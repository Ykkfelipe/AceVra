import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalProcessRunner } from "./localProcessRunner.js";

const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};
const dir = async () => realpath(await mkdtemp(join(tmpdir(), "av-local-")));

test("local run produces the same Task/Event shape as a node: state, ordered events, result", async () => {
  const cwd = await dir();
  try {
    const runner = createLocalProcessRunner();
    const started = runner.start({
      executable: process.execPath,
      args: ["-e", "console.log('hi'); console.error('oops')"],
      cwd,
    });
    assert.ok(started.ok);
    const id = (started as { taskId: string }).taskId;
    assert.match(id, /^local-/);
    await until(() => runner.list()[0]!.state === "completed");
    const events = runner.events(id, 0)!;
    assert.deepEqual(
      events.map((e) => e.sequence),
      events.map((_, i) => i + 1),
    );
    assert.deepEqual(
      [events[0]!.type, events[1]!.type, events[2]!.type],
      ["task.created", "task.accepted", "process.started"],
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "process.output" &&
          e.payload.stream === "stdout" &&
          String(e.payload.text).includes("hi"),
      ),
    );
    assert.ok(events.some((e) => e.type === "process.output" && e.payload.stream === "stderr"));
    assert.equal(events.at(-1)!.type, "process.completed");
    assert.equal(runner.list()[0]!.result!.exitCode, 0);
    assert.deepEqual(
      runner.events(id, events.length - 1)!.map((e) => e.sequence),
      [events.length],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local failure, bad cwd and invalid specs", async () => {
  const cwd = await dir();
  try {
    const runner = createLocalProcessRunner();
    const failed = runner.start({
      executable: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd,
    }) as { taskId: string };
    await until(() => runner.list().find((t) => t.id === failed.taskId)!.state === "failed");
    assert.equal(runner.list().find((t) => t.id === failed.taskId)!.result!.reason, "exit_nonzero");
    const bad = runner.start({ executable: process.execPath, cwd: join(cwd, "missing") }) as {
      taskId: string;
    };
    await until(() => runner.list().find((t) => t.id === bad.taskId)!.state === "failed");
    assert.equal(runner.list().find((t) => t.id === bad.taskId)!.result!.reason, "rejected");
    assert.deepEqual(runner.start({ executable: "", cwd }), { ok: false });
    assert.deepEqual(runner.start({ executable: "x", cwd: "relative", env: { PATH: "/evil" } }), {
      ok: false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local cancel terminates the process and reports cancelled; shutdown stops everything", async () => {
  const cwd = await dir();
  try {
    const runner = createLocalProcessRunner();
    const { taskId } = runner.start({
      executable: process.execPath,
      args: ["-e", "console.log('up'); setInterval(() => {}, 1000)"],
      cwd,
      timeoutMs: 120_000,
    }) as { taskId: string };
    await until(() => (runner.events(taskId, 0) ?? []).some((e) => e.type === "process.output"));
    assert.equal(runner.cancel(taskId)!.state, "cancelling");
    await until(() => runner.list()[0]!.state === "cancelled");
    assert.equal(runner.list()[0]!.result!.acknowledged, true);
    assert.equal(runner.cancel("local-unknown"), null);
    const second = runner.start({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd,
      timeoutMs: 120_000,
    }) as { taskId: string };
    await until(() => runner.list().find((t) => t.id === second.taskId)!.state === "running");
    runner.shutdown();
    await until(() => runner.list().find((t) => t.id === second.taskId)!.state === "cancelled");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
