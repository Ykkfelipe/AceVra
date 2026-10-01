import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestApp } from "../../account-api/test/helpers.ts";
import { main } from "../src/cli.ts";
import { resolveNodePaths } from "../src/dataRoot.ts";

const person = (n: string) => ({
  displayName: n,
  avatarUrl: null,
  verifiedEmails: [`${n}@example.test`],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(
  fn: () => Promise<T | false | undefined> | T | false | undefined,
  ms = 10_000,
): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error("timeout");
};

async function harness() {
  const t = await createTestApp({ users: { u_a: person("a") }, realClock: true, nodeGraceMs: 500 });
  await t.ledger.approve({ clerkUserId: "u_a" });
  const home = await mkdtemp(join(tmpdir(), "av-node-t-"));
  const project = await realpath(await mkdtemp(join(tmpdir(), "av-proj-")));
  await mkdir(join(project, "app"));
  const paths = resolveNodePaths({ ACEVRA_NODE_HOME: home });
  const a = t.as("u_a");
  const json = async (r: Response) => (await r.json()) as any;
  const run = (api: string, extra: string[] = []) => {
    const controller = new AbortController();
    let output = "";
    const done = main(["node", "connect", "--api", api, ...extra], {
      env: { ACEVRA_NODE_HOME: home },
      stdout: { write: (v) => void (output += v) },
      stderr: { write: (v) => void (output += v) },
      signal: controller.signal,
      pollMs: 40,
      channel: { minDelayMs: 40, maxDelayMs: 150 },
    });
    return { done, stop: () => controller.abort(), out: () => output };
  };
  const statusOf = async () =>
    JSON.parse(await readFile(paths.status, "utf8").catch(() => "{}")).connection as
      | string
      | undefined;
  /** Pair + connect a node allowed to run in `project`. Returns the device id. */
  async function pairedNode(api: string, roots = true) {
    const node = run(api, roots ? ["--allow-root", project] : []);
    const code = await until(() => node.out().match(/Code: ([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1]);
    const found = await json(await a("/v1/pairings/lookup", { method: "POST", json: { code } }));
    await a(`/v1/pairings/${found.pairing.id}/approve`, { method: "POST", json: {} });
    await until(async () => (await statusOf()) === "connected");
    const deviceId = (await json(await a("/v1/devices"))).devices[0].id as string;
    return { node, deviceId };
  }
  const spawnTask = async (
    deviceId: string,
    args: string[],
    extra: Record<string, unknown> = {},
    cwd = join(project, "app"),
  ) => {
    const r = await a("/v1/tasks", {
      method: "POST",
      json: {
        targetDeviceId: deviceId,
        process: { executable: process.execPath, args, cwd, timeoutMs: 20_000, ...extra },
      },
    });
    return { status: r.status, body: await json(r) };
  };
  const task = async (id: string) => (await json(await a(`/v1/tasks/${id}`))).task;
  const events = async (id: string, after = 0) =>
    (await json(await a(`/v1/tasks/${id}/events?after=${after}&limit=500`))).events as any[];
  const waitState = (id: string, state: string, ms = 10_000) =>
    until(async () => (await task(id)).state === state, ms);
  return {
    t,
    home,
    project,
    paths,
    a,
    json,
    run,
    statusOf,
    pairedNode,
    spawnTask,
    task,
    events,
    waitState,
    cleanup: async () => (
      await rm(home, { recursive: true, force: true }),
      await rm(project, { recursive: true, force: true })
    ),
  };
}

test("shell is advertised only after the service is ready (allowed root + passing self-test), never by OS", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const bare = await h.pairedNode(srv.url, false);
    assert.deepEqual(
      (await h.json(await h.a("/v1/devices"))).devices[0].capabilities,
      [],
      "no roots → no shell",
    );
    const targets = (await h.json(await h.a("/v1/targets"))).targets;
    assert.equal(targets[0].available, false);
    assert.equal(targets[0].unavailableReason, "no_shell_service");
    assert.equal((await h.spawnTask(bare.deviceId, ["-e", "0"])).status, 409);
    bare.node.stop();
    await bare.node.done;
    // Same identity, now with an explicit root: shell appears after readiness.
    const again = h.run(srv.url, ["--allow-root", h.project]);
    await until(async () => (await h.statusOf()) === "connected");
    await until(async () =>
      (await h.json(await h.a("/v1/devices"))).devices[0].capabilities.includes("shell"),
    );
    assert.equal((await h.json(await h.a("/v1/targets"))).targets[0].available, true);
    again.stop();
    await again.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("live streaming: events appear while the process runs; stdout, stderr and exit 0", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const { node, deviceId } = await h.pairedNode(srv.url);
    const { body } = await h.spawnTask(deviceId, [
      "-e",
      "console.log('71 tests discovered'); console.error('warn'); setTimeout(() => console.log('42 passed'), 900)",
    ]);
    const id = body.task.id;
    const seen = await until(async () => {
      const ev = await h.events(id);
      return ev.some((e) => e.type === "process.output" && e.payload.text.includes("71 tests"))
        ? ev
        : false;
    });
    assert.equal(
      (await h.task(id)).state,
      "running",
      "still running while output is already visible",
    );
    assert.ok(!seen.some((e) => e.type === "process.completed"));
    await h.waitState(id, "completed");
    const all = await h.events(id);
    const out = all.filter((e) => e.type === "process.output");
    assert.ok(
      out.some((e) => e.payload.stream === "stdout" && e.payload.text.includes("42 passed")),
    );
    assert.ok(out.some((e) => e.payload.stream === "stderr" && e.payload.text.includes("warn")));
    assert.equal((await h.task(id)).result.exitCode, 0);
    assert.deepEqual(
      all.map((e) => e.sequence),
      all.map((_, i) => i + 1),
      "ordered and gap-free",
    );
    node.stop();
    await node.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("non-zero exit and timeout are failed with reasons; spawn failure is reported", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const { node, deviceId } = await h.pairedNode(srv.url);
    const bad = (await h.spawnTask(deviceId, ["-e", "console.log('2 failed'); process.exit(1)"]))
      .body.task.id;
    await h.waitState(bad, "failed");
    assert.deepEqual(
      { reason: (await h.task(bad)).result.reason, code: (await h.task(bad)).result.exitCode },
      { reason: "exit_nonzero", code: 1 },
    );
    const slow = (
      await h.spawnTask(deviceId, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 1000 })
    ).body.task.id;
    await h.waitState(slow, "failed");
    assert.equal((await h.task(slow)).result.reason, "timeout");
    const missing = (await h.spawnTask(deviceId, [], { executable: "no-such-binary-xyz" })).body
      .task.id;
    await h.waitState(missing, "failed");
    assert.equal((await h.task(missing)).result.reason, "spawn_failed");
    node.stop();
    await node.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("policy: a cwd outside the allowed root is rejected by the node", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const { node, deviceId } = await h.pairedNode(srv.url);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "av-out-")));
    const denied = (await h.spawnTask(deviceId, ["-e", "0"], {}, outside)).body.task.id;
    await h.waitState(denied, "failed");
    assert.deepEqual(
      {
        reason: (await h.task(denied)).result.reason,
        detail: (await h.task(denied)).result.detail,
      },
      { reason: "rejected", detail: "policy" },
    );
    await rm(outside, { recursive: true, force: true });
    node.stop();
    await node.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("cancellation: the node kills the process and only then is the task cancelled", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const { node, deviceId } = await h.pairedNode(srv.url);
    const id = (
      await h.spawnTask(
        deviceId,
        ["-e", "console.log('long task started'); setInterval(() => {}, 1000)"],
        { timeoutMs: 120_000 },
      )
    ).body.task.id;
    await until(async () => (await h.events(id)).some((e) => e.type === "process.output"));
    const pid = (await h.events(id)).find((e) => e.type === "process.started").payload.pid;
    process.kill(pid, 0); // alive
    const cancelled = await h.json(
      await h.a(`/v1/tasks/${id}/cancel`, { method: "POST", json: {} }),
    );
    assert.equal(
      cancelled.task.state,
      "cancelling",
      "not claimed cancelled until the node confirms",
    );
    await h.waitState(id, "cancelled");
    assert.equal((await h.task(id)).result.acknowledged, true);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    node.stop();
    await node.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("output flood: bounded, truncated with a marker, and the task still completes", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const { node, deviceId } = await h.pairedNode(srv.url);
    const id = (
      await h.spawnTask(deviceId, [
        "-e",
        "for (let i = 0; i < 3000; i++) process.stdout.write('line '.repeat(100) + '\\n'); console.log('END')",
      ])
    ).body.task.id;
    await h.waitState(id, "completed", 30_000);
    const ev = await h.events(id);
    const bytes = ev
      .filter((e) => e.type === "process.output")
      .reduce((n, e) => n + Buffer.byteLength(e.payload.text), 0);
    assert.ok(bytes <= 1 << 20, `stored output is capped (${bytes})`);
    assert.equal(
      ev.filter((e) => e.type === "process.truncated").length >= 1,
      true,
      "truncation is recorded",
    );
    assert.ok((await h.task(id)).result.droppedBytes > 0, "dropped bytes are reported");
    node.stop();
    await node.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("disconnect during a task: running_unknown, then the SAME process continues and completes after reconnect (no second execution)", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const { node, deviceId } = await h.pairedNode(srv.url);
    const marker = join(h.project, "app", "runs.txt");
    const id = (
      await h.spawnTask(deviceId, [
        "-e",
        `require('fs').appendFileSync(${JSON.stringify(marker)}, 'run\\n'); console.log('started'); setTimeout(() => console.log('finished'), 2500)`,
      ])
    ).body.task.id;
    await until(async () => (await h.events(id)).some((e) => e.type === "process.output"));
    h.t.channel.closeDevice(deviceId, "terminate"); // the network drops
    await until(async () => ["running_unknown", "running"].includes((await h.task(id)).state));
    await h.waitState(id, "completed", 15_000);
    const ev = await h.events(id);
    assert.ok(
      ev.some((e) => e.type === "process.output" && e.payload.text.includes("finished")),
      "output produced while offline was delivered",
    );
    assert.equal(
      (await readFile(marker, "utf8")).trim().split("\n").length,
      1,
      "executed exactly once",
    );
    node.stop();
    await node.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});

test("a result finished while the backend was down is delivered after the backend returns", async () => {
  const h = await harness();
  const first = await h.t.listen();
  try {
    const { node, deviceId } = await h.pairedNode(first.url);
    const id = (
      await h.spawnTask(deviceId, [
        "-e",
        "console.log('begin'); setTimeout(() => console.log('done while offline'), 600)",
      ])
    ).body.task.id;
    await until(async () => (await h.events(id)).some((e) => e.type === "process.output"));
    await first.close(); // control plane restarts
    await sleep(1200); // the process finishes while nobody is listening
    const second = await h.t.listen(first.port);
    try {
      await until(async () => (await h.statusOf()) === "connected", 15_000);
      await h.waitState(id, "completed", 15_000);
      assert.ok(
        (await h.events(id)).some(
          (e) => e.type === "process.output" && e.payload.text.includes("done while offline"),
        ),
      );
      node.stop();
      await node.done;
    } finally {
      await second.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("node restart: the child cannot be recovered, so the task is reported interrupted, never completed", async () => {
  const h = await harness();
  const srv = await h.t.listen();
  try {
    const { node, deviceId } = await h.pairedNode(srv.url);
    const id = (
      await h.spawnTask(deviceId, ["-e", "console.log('working'); setInterval(() => {}, 1000)"], {
        timeoutMs: 120_000,
      })
    ).body.task.id;
    await until(async () => (await h.events(id)).some((e) => e.type === "process.output"));
    node.stop(); // the node process goes away; its children are stopped with it
    await node.done;
    await until(async () => (await h.task(id)).state === "running_unknown");
    const restarted = h.run(srv.url, ["--allow-root", h.project]);
    await h.waitState(id, "failed");
    assert.equal((await h.task(id)).result.reason, "interrupted");
    restarted.stop();
    await restarted.done;
  } finally {
    await srv.close();
    await h.cleanup();
  }
});
