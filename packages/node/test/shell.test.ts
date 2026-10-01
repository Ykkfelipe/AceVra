import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createShellService, type RunHooks, type Stream } from "../src/shell/executor.ts";
import { isInside } from "../src/shell/policy.ts";
import { buildChildEnv, parseProcessSpec, type ProcessSpec } from "../src/shell/spec.ts";
import { buildBatchInvocation, resolveWindowsExecutable } from "../src/shell/windows.ts";

const NODE = process.execPath;
const spec = (cwd: string, args: string[], extra: Partial<ProcessSpec> = {}): ProcessSpec => ({
  executable: NODE,
  args,
  cwd,
  env: {},
  timeoutMs: 20_000,
  ...extra,
});

async function sandbox() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "av-shell-")));
  const service = createShellService({ roots: [root], limits: { flushMs: 20 } });
  return { root, service, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function collector(options: { full?: () => boolean } = {}) {
  const out: { stream: Stream; text: string; bytes: number }[] = [];
  let pid = 0;
  let truncated = 0;
  let resume: (() => void) | null = null;
  const hooks: RunHooks = {
    started: (p) => (pid = p),
    output: (stream, text, bytes) => (
      out.push({ stream, text, bytes }), !(options.full?.() ?? false)
    ),
    truncated: () => truncated++,
    onDrain: (r) => (resume = r),
  };
  return {
    hooks,
    out,
    pid: () => pid,
    truncated: () => truncated,
    drain: () => resume?.(),
    text: (s: Stream) =>
      out
        .filter((o) => o.stream === s)
        .map((o) => o.text)
        .join(""),
  };
}
async function run(
  service: ReturnType<typeof createShellService>,
  s: ProcessSpec,
  c = collector(),
) {
  const prepared = await service.prepare(s);
  assert.ok(!("error" in prepared), JSON.stringify(prepared));
  const handle = service.run(prepared, c.hooks);
  return { handle, c, outcome: handle.done };
}

test("stdout, stderr and exit 0 are streamed and reported", async () => {
  const { root, service, cleanup } = await sandbox();
  try {
    const r = await run(
      service,
      spec(root, ["-e", "console.log('hello out'); console.error('hello err')"]),
    );
    const outcome = await r.outcome;
    assert.deepEqual(
      { kind: outcome.kind, code: (outcome as any).exitCode },
      { kind: "exit", code: 0 },
    );
    assert.match(r.c.text("stdout"), /hello out/);
    assert.match(r.c.text("stderr"), /hello err/);
    assert.ok(r.c.pid() > 0);
  } finally {
    await cleanup();
  }
});

test("non-zero exit code is reported faithfully", async () => {
  const { root, service, cleanup } = await sandbox();
  try {
    const outcome = await (await run(service, spec(root, ["-e", "process.exit(7)"]))).outcome;
    assert.equal((outcome as any).exitCode, 7);
  } finally {
    await cleanup();
  }
});

test("output arrives while the process is still running (not one final blob)", async () => {
  const { root, service, cleanup } = await sandbox();
  try {
    const r = await run(
      service,
      spec(root, ["-e", "console.log('first'); setTimeout(() => console.log('second'), 800)"]),
    );
    const start = Date.now();
    while (!r.c.text("stdout").includes("first") && Date.now() - start < 5000)
      await new Promise((x) => setTimeout(x, 20));
    assert.ok(r.c.text("stdout").includes("first"));
    assert.ok(!r.c.text("stdout").includes("second"), "second line has not been produced yet");
    await r.outcome;
    assert.match(r.c.text("stdout"), /second/);
  } finally {
    await cleanup();
  }
});

test("timeout kills the process and reports timeout", async () => {
  const { root, service, cleanup } = await sandbox();
  try {
    const started = Date.now();
    const outcome = await (
      await run(service, spec(root, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 1000 }))
    ).outcome;
    assert.equal(outcome.kind, "timeout");
    assert.ok(Date.now() - started < 10_000);
  } finally {
    await cleanup();
  }
});

test("cancellation terminates the whole tree (child and grandchild)", async () => {
  const { root, service, cleanup } = await sandbox();
  try {
    const grandchild =
      "require('child_process').spawn(process.execPath, ['-e', \"setInterval(()=>{},1000)\"], {stdio:'ignore'}); console.log('GC:'+process.pid); setInterval(()=>{},1000)";
    const r = await run(service, spec(root, ["-e", grandchild]));
    const start = Date.now();
    while (!r.c.text("stdout").includes("GC:") && Date.now() - start < 5000)
      await new Promise((x) => setTimeout(x, 20));
    r.handle.cancel();
    const outcome = await r.outcome;
    assert.equal(outcome.kind, "cancelled");
    const pid = r.c.pid();
    await new Promise((x) => setTimeout(x, 200));
    assert.throws(() => process.kill(pid, 0), "child is gone");
  } finally {
    await cleanup();
  }
});

test("a missing executable is a spawn failure, not a hang or crash", async () => {
  const { root, service, cleanup } = await sandbox();
  try {
    const outcome = await (
      await run(service, spec(root, [], { executable: "definitely-not-a-real-binary-xyz" }))
    ).outcome;
    assert.equal(outcome.kind, "spawn_failed");
  } finally {
    await cleanup();
  }
});

test("oversized output is truncated with a recorded marker and a dropped-byte count; nothing is silent", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "av-shell-")));
  const service = createShellService({
    roots: [root],
    limits: { maxOutputBytes: 10_000, flushMs: 20 },
  });
  try {
    const r = await run(service, spec(root, ["-e", "process.stdout.write('x'.repeat(200000))"]));
    const outcome = await r.outcome;
    assert.equal(r.c.truncated(), 1, "exactly one truncation marker");
    const kept = r.c.out.reduce((n, o) => n + o.bytes, 0);
    assert.ok(kept <= 10_000);
    assert.equal(kept + outcome.droppedBytes, 200_000, "kept + dropped accounts for every byte");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("events are chunked to the configured size and multi-byte characters are never split", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "av-shell-")));
  const service = createShellService({ roots: [root], limits: { chunkBytes: 1000, flushMs: 20 } });
  try {
    const r = await run(service, spec(root, ["-e", "process.stdout.write('é€😀'.repeat(900))"]));
    await r.outcome;
    assert.ok(r.c.out.every((o) => o.bytes <= 1000));
    assert.equal(r.c.text("stdout"), "é€😀".repeat(900), "reassembled output is exact (no U+FFFD)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backpressure: a full downstream pauses the child; draining resumes it; no output is lost", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "av-shell-")));
  const service = createShellService({ roots: [root], limits: { chunkBytes: 1024, flushMs: 10 } });
  try {
    let full = true;
    const c = collector({ full: () => full });
    const r = await run(
      service,
      spec(root, [
        "-e",
        "for (let i = 0; i < 400; i++) process.stdout.write('y'.repeat(1024)); console.log('END')",
      ]),
      c,
    );
    await new Promise((x) => setTimeout(x, 400));
    const whilePaused = c.out.length;
    await new Promise((x) => setTimeout(x, 300));
    assert.ok(c.out.length - whilePaused <= 4, "producer is throttled while downstream is full");
    full = false;
    c.drain();
    const outcome = await r.outcome;
    assert.equal(outcome.kind, "exit");
    assert.ok(c.text("stdout").endsWith("END\n"));
    assert.equal(c.text("stdout").length, 400 * 1024 + 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cwd policy: inside the allowed root only; traversal and symlink escapes are refused", async () => {
  const { root, service, cleanup } = await sandbox();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "av-outside-")));
  try {
    await mkdir(join(root, "project"));
    assert.ok(!("error" in (await service.prepare(spec(join(root, "project"), [])))));
    assert.ok("error" in (await service.prepare(spec(outside, []))));
    assert.ok("error" in (await service.prepare(spec(join(root, "project", "..", ".."), []))));
    assert.ok("error" in (await service.prepare(spec("relative/dir", []))));
    assert.ok("error" in (await service.prepare(spec(join(root, "does-not-exist"), []))));
    await symlink(outside, join(root, "escape"));
    assert.ok(
      "error" in (await service.prepare(spec(join(root, "escape"), []))),
      "symlink out of the root",
    );
    assert.equal(isInside("/a/b", "/a/bc"), false, "segment-aware prefix check");
    assert.equal(isInside("/a/b", "/a/b/c"), true);
  } finally {
    await cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("environment: allowlisted base + validated additions; secrets and loader variables never reach the child", async () => {
  const { root, service, cleanup } = await sandbox();
  try {
    process.env.ACEVRA_SECRET_PROBE = "leak";
    process.env.SOME_TOKEN_PROBE = "leak2";
    const r = await run(
      service,
      spec(
        root,
        [
          "-e",
          "console.log(JSON.stringify({a: process.env.ACEVRA_SECRET_PROBE, t: process.env.SOME_TOKEN_PROBE, x: process.env.MY_FLAG}))",
        ],
        { env: { MY_FLAG: "on" } },
      ),
    );
    await r.outcome;
    assert.deepEqual(JSON.parse(r.c.text("stdout")), { x: "on" });
    assert.equal(buildChildEnv({}, { PATH: "/bin", ACEVRA_X: "1" }).ACEVRA_X, undefined);
  } finally {
    delete process.env.ACEVRA_SECRET_PROBE;
    delete process.env.SOME_TOKEN_PROBE;
    await cleanup();
  }
});

test("readiness is earned: no roots → not ready; roots + a working spawn → ready", async () => {
  assert.equal(await createShellService({ roots: [] }).ready(), false);
  const { service, cleanup } = await sandbox();
  try {
    assert.equal(await service.ready(), true);
  } finally {
    await cleanup();
  }
  assert.equal(await createShellService({ roots: ["/definitely/not/a/dir"] }).ready(), false);
});

test("spec validation is strict", () => {
  const ok = { executable: "git", args: ["status"], cwd: "/p", env: { A: "1" }, timeoutMs: 5000 };
  assert.ok(parseProcessSpec(ok));
  for (const bad of [
    { ...ok, extra: 1 },
    { ...ok, executable: "" },
    { ...ok, executable: "a\nb" },
    { ...ok, args: "x" },
    { ...ok, args: Array.from({ length: 65 }, () => "a") },
    { ...ok, args: ["a\0b"] },
    { ...ok, cwd: "" },
    { ...ok, env: { PATH: "/evil" } },
    { ...ok, env: { LD_PRELOAD: "/x" } },
    { ...ok, env: { NODE_OPTIONS: "--require x" } },
    { ...ok, env: { ACEVRA_TOKEN: "x" } },
    { ...ok, env: { lower: "x" } },
    { ...ok, timeoutMs: 10 },
    { ...ok, timeoutMs: 99_999_999 },
    { ...ok, timeoutMs: "5000" },
    null,
    [],
  ]) {
    assert.equal(parseProcessSpec(bad), null, JSON.stringify(bad));
  }
});

test("windows: PATHEXT resolution and batch-file argument safety (pure logic)", async () => {
  const present = new Set(["C:\\tools\\pnpm.cmd", "C:\\Program Files\\Git\\git.exe"]);
  const exists = async (p: string) => present.has(p);
  assert.equal(
    await resolveWindowsExecutable("pnpm", { Path: "C:\\x;C:\\tools" }, exists),
    "C:\\tools\\pnpm.cmd",
  );
  assert.equal(
    await resolveWindowsExecutable("git", { Path: "C:\\Program Files\\Git" }, exists),
    "C:\\Program Files\\Git\\git.exe",
  );
  assert.equal(await resolveWindowsExecutable("nope", { Path: "C:\\tools" }, exists), null);
  const ok = buildBatchInvocation("C:\\tools\\pnpm.cmd", ["test", "--filter", "app one"]);
  assert.ok(ok && ok.windowsVerbatimArguments);
  for (const evil of ["a & calc", "a | b", "%PATH%", "a > out", "^x", '"; x', "a\nb", "$(x)!"]) {
    assert.equal(buildBatchInvocation("C:\\tools\\pnpm.cmd", [evil]), null, evil);
  }
  assert.equal(buildBatchInvocation("C:\\a&b\\x.cmd", []), null);
});
