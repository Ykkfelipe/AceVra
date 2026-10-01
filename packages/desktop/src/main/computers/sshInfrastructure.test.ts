/**
 * SSH process infrastructure for SSH computers (acevra-agent-computer.md §4.6): PowerShell
 * quoting, remote process lifecycle with a real Stop, alias validation, tunnel arguments and
 * reconnect backoff. Main never runs anything locally on behalf of an SSH target.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { encodePowerShell, type SpawnFn } from "./sshCommand.js";
import { createSshComputersStore, isValidHostAlias } from "./sshComputersStore.js";
import { buildPowerShellScript, createSshProcessRunner } from "./sshProcessRunner.js";
import { createSshTunnel, tunnelArgs } from "./sshTunnel.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const killed: Array<string | undefined> = [];
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    kill: (signal?: string) => {
      killed.push(signal);
      setImmediate(() => child.emit("close", 255, null));
      return true;
    },
  });
  return { child, killed };
}

test("PowerShell script quotes every value and keeps the process exit code", () => {
  const script = buildPowerShellScript({
    executable: "C:\\Program Files\\Git\\bin\\git.exe",
    args: ["log", "--format=%H'; Remove-Item C:\\ -Recurse"],
    cwd: "C:\\agent",
    env: { GOOD_KEY: "it's", "BAD;KEY": "x" },
  });
  assert.match(script, /Set-Item -LiteralPath 'Env:GOOD_KEY' -Value 'it''s'/);
  assert.ok(!script.includes("BAD;KEY"));
  assert.match(script, /Set-Location -LiteralPath 'C:\\agent'/);
  assert.match(
    script,
    /& 'C:\\Program Files\\Git\\bin\\git.exe' 'log' '--format=%H''; Remove-Item C:\\ -Recurse'/,
  );
  assert.match(script, /exit \$LASTEXITCODE/);
  assert.equal(Buffer.from(encodePowerShell("é"), "base64").toString("utf16le"), "é");
});

test("ssh runner streams output, reports exit codes and Stop kills the ssh client", async () => {
  const spawned: Array<{ args: string[]; child: ReturnType<typeof fakeChild> }> = [];
  const spawn: SpawnFn = (_command, args) => {
    const fake = fakeChild();
    spawned.push({ args, child: fake });
    return fake.child;
  };
  const runner = createSshProcessRunner({ spawn });
  const ok = runner.start({
    targetId: "ssh:dell",
    hostAlias: "dell",
    process: { executable: "whoami", cwd: "C:\\agent" },
  });
  const first = spawned[0]!;
  assert.ok(first.args.includes("dell"));
  assert.ok(first.args.includes("-EncodedCommand"));
  assert.ok(first.args.includes("BatchMode=yes"));
  first.child.child.stdout?.emit("data", Buffer.from("dell\\notfe\r\n"));
  first.child.child.emit("close", 0, null);
  assert.equal(runner.get(ok.taskId)?.state, "completed");
  assert.ok(
    runner
      .events(ok.taskId, 0)
      ?.some((e) => e.type === "process.output" && e.payload.text === "dell\\notfe\r\n"),
  );

  const failing = runner.start({
    targetId: "ssh:dell",
    hostAlias: "dell",
    process: { executable: "x", cwd: "C:\\" },
  });
  spawned[1]!.child.child.emit("close", 255, null);
  assert.equal(runner.get(failing.taskId)?.result?.reason, "ssh_failed");

  const long = runner.start({
    targetId: "ssh:dell",
    hostAlias: "dell",
    process: { executable: "ping", args: ["-t", "localhost"], cwd: "C:\\" },
  });
  runner.cancelForTarget("ssh:dell");
  assert.equal(runner.get(long.taskId)?.state, "cancelling");
  assert.equal(spawned[2]!.child.killed.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.get(long.taskId)?.state, "cancelled");
});

test("host aliases can never be parsed as ssh options", () => {
  assert.equal(isValidHostAlias("dell"), true);
  assert.equal(isValidHostAlias("notfe@192.168.1.20"), true);
  assert.equal(isValidHostAlias("-oProxyCommand=evil"), false);
  assert.equal(isValidHostAlias("dell box"), false);
  assert.equal(isValidHostAlias(""), false);
});

test("store keeps alias + port only and survives a reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-computers-"));
  const file = join(dir, "ssh-computers.json");
  const store = createSshComputersStore(file);
  const added = await store.add({ name: "Dell", hostAlias: "dell", workerPort: 8765 });
  assert.equal(added?.length, 1);
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(raw.version, 1);
  assert.ok(!JSON.stringify(raw).toLowerCase().includes("token"));
  const reloaded = await createSshComputersStore(file).list();
  assert.deepEqual(
    reloaded.map((c) => [c.name, c.hostAlias, c.workerPort]),
    [["Dell", "dell", 8765]],
  );
});

test("tunnel forwards loopback only and reconnects with backoff while retained", async () => {
  assert.deepEqual(tunnelArgs("dell", 50123, 8765).slice(0, 5), [
    "-N",
    "-L",
    "127.0.0.1:50123:127.0.0.1:8765",
    "-o",
    "ExitOnForwardFailure=yes",
  ]);
  const delays: number[] = [];
  const timers: Array<() => void> = [];
  let spawns = 0;
  const spawn: SpawnFn = () => {
    spawns += 1;
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(child, { stderr: new EventEmitter(), exitCode: null, kill: () => true });
    setImmediate(() => {
      child.stderr?.emit("data", Buffer.from("Permission denied (publickey)."));
      (child as { exitCode: number | null }).exitCode = 255;
      child.emit("exit", 255);
    });
    return child;
  };
  const tunnel = createSshTunnel({
    hostAlias: "dell",
    workerPort: 8765,
    spawn,
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    pickPort: async () => 50123,
    setTimer: (fn, ms) => {
      delays.push(ms);
      timers.push(fn);
      return setTimeout(() => undefined, 0);
    },
  });
  const state = await tunnel.ensure();
  assert.deepEqual(state, { kind: "offline", reason: "auth_failed" });
  assert.deepEqual(delays, [1000]);
  timers.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawns, 2);
  assert.deepEqual(delays, [1000, 2000]);
  tunnel.release();
  assert.deepEqual(tunnel.state(), { kind: "idle" });
});
