#!/usr/bin/env node
// CUA-1 live evidence: observation invariants, the observe-only boundary, and the identity the
// production client actually accepts.
//
// Usage: node packages/zcode-cua/native/cua-helper/run-observe-invariants.mjs [--out DIR] [--keep-helper]
//
// What it drives, and why it is this and not a unit test:
//
//  * the *production path* — `callBrokerMethod` from packages/zcode-cua/broker.js, the same
//    function `createComputerUseRuntime.execute` calls, against a real signed helper launched the
//    way the contract launches it;
//  * one genuine non-frontmost window capture, with the frontmost application, the hardware
//    cursor position and the target window's z-order recorded before and after. An observation
//    that changed any of them would be a foreground operation wearing a background label;
//  * the observe-only boundary, including malformed and direct socket writes, because "the tool
//    is not registered" and "the helper refuses it" are different claims and the second one is
//    what actually holds.
//
// It needs Accessibility + Screen Recording granted to the dev helper to be meaningful, and it
// FAILS (exit 1) if the capture rung is missing or blank — this script exists to prove the real
// non-blank non-frontmost capture the acceptance requires, so a degraded run must not exit 0. The
// helper itself degrades gracefully without those grants; this assertion is about the evidence.

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const { callBrokerMethod } = await import(join(repoRoot, "packages/zcode-cua/broker.js"));
const { sanitizeObservationResult } = await import(
  join(repoRoot, "packages/zcode-cua/observe-result.js")
);
const { createComputerUseRuntime } = await import(join(repoRoot, "packages/zcode-cua/index.js"));

const argValue = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const has = (name) => process.argv.includes(name);

const CUA_HOME = process.env.ZCODE_CUA_HOME?.trim() || join(homedir(), ".zcode-fork-cua-home");
const ZCODE_HOME = process.env.ZCODE_HOME?.trim() || join(CUA_HOME, ".zcode");
const APP = join(ZCODE_HOME, "computer-use/dev/ZCode Computer Use Dev.app");
const BIN = join(APP, "Contents/MacOS/ZCodeComputerUseDev");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// Evidence lands beside the other archived helper runs, never inside the repository: it is a
// measurement, not a source file.
const outDir = resolve(
  argValue("--out", join(CUA_HOME, "evidence", `observe-invariants-${stamp}`)),
);
mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, "run.log");
const logLines = [];
function log(line) {
  const text = typeof line === "string" ? line : JSON.stringify(line);
  logLines.push(text);
  process.stdout.write(`${text}\n`);
}
const failures = [];
function check(ok, description, detail) {
  log(`${ok ? "PASS" : "FAIL"}  ${description}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(description);
}

// MARK: - The invariant instrument

function buildInvariantProbe() {
  const out = join(outDir, "invariant-probe");
  if (!existsSync(out)) {
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-O",
        "-swift-version",
        "5",
        "-target",
        "arm64-apple-macos13.0",
        "-framework",
        "AppKit",
        "-framework",
        "CoreGraphics",
        "-o",
        out,
        join(here, "evidence/InvariantProbe.swift"),
      ],
      { stdio: "inherit" },
    );
  }
  return out;
}

function desktopState(probe) {
  const raw = execFileSync(probe, { encoding: "utf8" });
  return JSON.parse(raw);
}

function windowRow(state, windowId) {
  return state.windows.find((row) => row.window_id === windowId) ?? null;
}

/**
 * The window the frontmost application is showing at the front — the first of its layer-0 windows
 * in z-order. This, not a raw list index, is what "the capture did not raise anything" means: the
 * window server's enumeration index also counts every other window on the system, so it shifts by
 * one whenever an unrelated window (a tooltip, a service stub) appears or vanishes. Comparing the
 * *front window of the frontmost app* and the target's rank *within its own application* is stable
 * against that churn and still catches the thing that matters.
 */
function frontWindowOf(state, pid) {
  return state.windows.find((row) => row.pid === pid) ?? null;
}

function rankWithinApp(state, windowId, pid) {
  const own = state.windows.filter((row) => row.pid === pid);
  const index = own.findIndex((row) => row.window_id === windowId);
  return index < 0 ? null : index;
}

function countPngs(directory) {
  try {
    return execFileSync("/bin/ls", [directory], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter((name) => name.endsWith(".png")).length;
  } catch {
    return 0;
  }
}

// MARK: - Helper lifecycle

function launchHelper(socketPath, idleMs, observationDir) {
  const args = [
    "-n",
    APP,
    "--args",
    "--serve",
    "--socket",
    socketPath,
    "--idle-ms",
    String(idleMs),
    "--observation-dir",
    observationDir,
  ];
  const result = spawnSync("/usr/bin/open", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`open failed: ${result.stderr ?? result.status}`);
}

async function waitForSocket(socketPath, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await callBrokerMethod({ socketPath, method: "permission_status", timeoutMs: 1000 });
      return true;
    } catch {
      if (process.env.DEBUG_CUA_PROBE) log(`  waiting: ${Date.now()}`);
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function stopHelper() {
  if (has("--keep-helper")) return;
  // Scoped to this exact binary and its serve flag; nothing else is touched.
  spawnSync("/usr/bin/pkill", ["-f", `${BIN} --serve`], { encoding: "utf8" });
}

/** Raw socket write, bypassing the client entirely: the malformed/direct attempts. */
async function rawSocket(socketPath, payload) {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(buffer.slice(0, newline));
    });
    socket.on("error", (error) => finish(`<socket error: ${error.message}>`));
    setTimeout(() => finish(buffer || "<no response>"), 5000).unref?.();
  });
}

// MARK: - Main

// The socket lives in the system temp dir, not in the evidence dir: a unix socket path is capped
// at ~104 bytes and the evidence path is long by design. Its location is logged.
const socketPath = join(tmpdir(), `cua-inv-${randomUUID().slice(0, 8)}.sock`);
let exitCode = 0;
try {
  log(`# CUA-1 observe invariants — ${new Date().toISOString()}`);
  log(`# app: ${APP}`);
  log(`# socket: ${socketPath}`);
  const verify = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--all-architectures", APP],
    { encoding: "utf8" },
  );
  log(`# codesign --verify --strict --all-architectures rc=${verify.status}`);
  const probe = buildInvariantProbe();

  const before = desktopState(probe);
  log(
    `before.frontmost=${JSON.stringify(before.frontmost)} cursor=${JSON.stringify(before.cursor)}`,
  );

  // The fork's own data root. Frames must not land in the product namespace (`~/.zcode`), which a
  // LaunchServices-launched helper falls back to when no `--observation-dir` is passed.
  const observationDir = join(ZCODE_HOME, "computer-use/observations");
  const productObservationDir = join(homedir(), ".zcode/computer-use/observations");
  const productFramesBefore = countPngs(productObservationDir);

  launchHelper(socketPath, 120000, observationDir);
  const ready = await waitForSocket(socketPath);
  check(ready, "helper answers on its socket");
  if (!ready) throw new Error("helper never became reachable");

  const status = await callBrokerMethod({
    socketPath,
    method: "permission_status",
    timeoutMs: 5000,
  });
  const identity = status.helper_identity ?? {};
  log(`helper_identity=${JSON.stringify(identity)}`);
  check(identity.verified === true, "helper identity verified through its own signature check");
  check(
    identity.identifier === "dev.zcode.cua-helper.dev",
    "grant_owner comes from the verified signing identifier",
    `grant_owner=${status.grant_owner}`,
  );
  check(status.grant_owner === identity.identifier, "grant_owner equals the verified identifier");
  check(
    status.screen_capture_probe_ok === null && status.screen_capture_probe_state === "not_run",
    "preflight readout is not reported as a functional probe result",
    `probe_ok=${JSON.stringify(status.screen_capture_probe_ok)} state=${status.screen_capture_probe_state}`,
  );
  log(
    `accessibility=${status.accessibility} screen_recording=${status.screen_recording} readout=${JSON.stringify(status.screen_recording_readout)}`,
  );

  // Pick a target that is NOT the frontmost application.
  const windows = await callBrokerMethod({ socketPath, method: "list_windows", timeoutMs: 8000 });
  const frontmostPid = before.frontmost.pid;
  const helpersPid = identity.pid;
  const candidates = windows.windows.filter(
    (row) => row.pid !== frontmostPid && row.pid !== helpersPid && row.pid > 0,
  );
  const target =
    candidates.find((row) => row.title && row.on_screen) ??
    candidates.find((row) => row.title) ??
    candidates.find((row) => (row.bounds?.w ?? 0) > 200 && (row.bounds?.h ?? 0) > 200) ??
    candidates[0];
  check(Boolean(target), "a non-frontmost layer-0 window exists to target");
  if (!target) throw new Error("no non-frontmost window available");
  log(
    `target=${JSON.stringify({ window_id: target.window_id, pid: target.pid, owner: target.owner, title: target.title })}`,
  );
  const targetBefore = windowRow(before, target.window_id);
  log(`target.before=${JSON.stringify(targetBefore)}`);

  const observation = await callBrokerMethod({
    socketPath,
    method: "observe",
    params: {
      pid: target.pid,
      window_id: target.window_id,
      include_image: true,
      include_tree: true,
    },
    timeoutMs: 30000,
  });
  const { result: modelFacing, redactions } = sanitizeObservationResult(observation);
  log(`observe.effect=${observation.effect} route=${observation.route}`);
  log(`observe.image=${JSON.stringify(observation.image)}`);
  log(
    `observe.tree.ok=${observation.tree?.ok ?? null} elements=${observation.tree?.element_count ?? 0} truncated=${observation.tree?.truncated ?? null} strings_truncated=${observation.tree?.strings_truncated ?? null}`,
  );
  log(`observe.error=${observation.error ?? "(none)"}`);
  log(`redactions=${JSON.stringify(redactions)}`);
  const modelText = JSON.stringify(modelFacing);
  check(
    !/\/(Users|private|var|tmp|Volumes|Applications|System|Library)\//.test(modelText),
    "no host filesystem path in the model-facing observation",
  );

  const after = desktopState(probe);
  log(`after.frontmost=${JSON.stringify(after.frontmost)} cursor=${JSON.stringify(after.cursor)}`);
  const cursorMoved =
    Math.abs(after.cursor.x - before.cursor.x) > 0.5 ||
    Math.abs(after.cursor.y - before.cursor.y) > 0.5;
  check(
    after.frontmost.bundleId === before.frontmost.bundleId &&
      after.frontmost.pid === before.frontmost.pid,
    "frontmost application unchanged across the capture",
    `${before.frontmost.bundleId} -> ${after.frontmost.bundleId}`,
  );
  check(
    !cursorMoved,
    "hardware cursor position unchanged across the capture",
    `${JSON.stringify(before.cursor)} -> ${JSON.stringify(after.cursor)}`,
  );
  const targetAfter = windowRow(after, target.window_id);
  const frontBefore = frontWindowOf(before, before.frontmost.pid);
  const frontAfter = frontWindowOf(after, after.frontmost.pid);
  log(`frontmostWindow.before=${JSON.stringify(frontBefore)} after=${JSON.stringify(frontAfter)}`);
  // If the frontmost application exposes no layer-0 window (a menu-bar-only or mid-transition app)
  // there is no front window to compare against. That is a property of the desktop, not evidence
  // about the capture, so those two checks are skipped rather than failed.
  const canCompareFront = frontBefore !== null && frontAfter !== null;
  if (!canCompareFront) {
    log("NOTE  the frontmost application exposes no layer-0 window; front-window checks skipped");
  } else {
    check(
      frontBefore.window_id === frontAfter.window_id,
      "the frontmost application is still showing the same window (nothing was raised)",
      `${frontBefore.window_id} -> ${frontAfter.window_id}`,
    );
  }
  check(targetAfter !== null, "the target window still exists after the capture");
  if (canCompareFront) {
    check(
      targetAfter !== null && targetAfter.z_order > frontAfter.z_order,
      "the target window is still behind the frontmost window (it did not become frontmost)",
      `target z=${targetAfter?.z_order} front z=${frontAfter.z_order}`,
    );
  }
  check(
    rankWithinApp(before, target.window_id, target.pid) ===
      rankWithinApp(after, target.window_id, target.pid),
    "the target window's rank within its own application is unchanged",
    `${rankWithinApp(before, target.window_id, target.pid)} -> ${rankWithinApp(after, target.window_id, target.pid)}`,
  );
  // Recorded, not asserted: the window server's global enumeration index also counts unrelated
  // windows, so a ±1 shift here is churn somewhere else on the desktop, not a raised window.
  log(
    `target.z_order ${targetBefore?.z_order} -> ${targetAfter?.z_order} (global index; informational)`,
  );
  // The brief's acceptance is a real, non-blank, non-frontmost capture, so the capture rung is a
  // hard requirement here rather than one rung of two.
  check(
    observation.image?.ok === true,
    "the capture rung produced a frame",
    `effect=${observation.effect} image=${JSON.stringify(observation.image)}`,
  );
  check(
    observation.image?.blank === false,
    "captured frame is non-blank",
    `distinct_sampled_colors=${observation.image?.distinct_sampled_colors}`,
  );
  check(
    observation.tree?.ok === true,
    "the AX rung served a tree",
    `tree.ok=${observation.tree?.ok ?? null} elements=${observation.tree?.element_count ?? 0}`,
  );
  check(
    observation.effect === "confirmed",
    "both rungs succeeded, so the effect is confirmed",
    `effect=${observation.effect} error=${observation.error ?? "(none)"}`,
  );
  if (observation.image?.ok === true) {
    check(
      typeof observation.image.path === "string" &&
        observation.image.path.startsWith(observationDir),
      "the frame landed in the runtime's own data root",
      observation.image.path,
    );
    check(
      countPngs(productObservationDir) === productFramesBefore,
      "no frame was written into the product data root (~/.zcode)",
      `${productFramesBefore} -> ${countPngs(productObservationDir)}`,
    );
    // Recorded, not asserted as a bound: this run writes one frame, so it cannot exercise the
    // 64-frame retention sweep. It does confirm the store stays in the expected place.
    log(`observation store now holds ${countPngs(observationDir)} frame(s)`);
  } else {
    log(`NOTE  the capture rung did not run: ${observation.error ?? "unknown"}`);
  }

  // Observe-only boundary, on the live socket.
  log("--- observe-only boundary ---");
  for (const method of [
    "left_click",
    "type",
    "key",
    "scroll",
    "drag",
    "set_value",
    "kill_app",
    "perform_action",
    "launch_app",
    "clipboard_read",
  ]) {
    const raw = JSON.parse(
      await rawSocket(
        socketPath,
        `${JSON.stringify({ id: method, method, params: { pid: target.pid } })}\n`,
      ),
    );
    check(
      raw.ok === false && raw.error?.code === "not_authorized",
      `direct socket call '${method}' refused with not_authorized`,
      JSON.stringify(raw.error),
    );
  }
  const malformed = JSON.parse(await rawSocket(socketPath, "this is not json\n"));
  check(
    malformed.ok === false && malformed.error?.code === "bad_request",
    "malformed line answered with bad_request",
    JSON.stringify(malformed.error),
  );
  const stillAlive = JSON.parse(
    await rawSocket(socketPath, `${JSON.stringify({ method: "permission_status" })}\n`),
  );
  check(stillAlive.ok === true, "the connection survives a malformed line");

  const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
  for (const toolName of ["left_click", "type", "key", "scroll", "set_value", "kill_app", "zoom"]) {
    const result = await runtime.execute({
      toolName,
      arguments: {},
      context: { sessionId: "probe" },
    });
    check(result.isError === true, `runtime refuses '${toolName}' without reaching the socket`);
  }
  const observeTool = await runtime.execute({
    toolName: "list_apps",
    arguments: {},
    context: { sessionId: "probe" },
  });
  check(observeTool.isError === undefined, "runtime still serves an observe-only tool");

  // Artifact boundary: the runtime's answer carries nothing deliverable.
  const observeViaRuntime = await runtime.execute({
    toolName: "observe",
    arguments: { pid: target.pid, window_id: target.window_id },
    context: { sessionId: "probe" },
  });
  const runtimeText = observeViaRuntime.content[0].text;
  check(
    observeViaRuntime.content.length === 1 && observeViaRuntime.content[0].type === "text",
    "runtime returns text only (no image/artifact content block)",
  );
  check(
    !/\/(Users|private|var|tmp|Volumes)\//.test(runtimeText),
    "runtime result carries no host path",
  );

  writeFileSync(join(outDir, "observation.json"), JSON.stringify(modelFacing, null, 2));
  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify({ before, after, target, status, observation: modelFacing, failures }, null, 2),
  );
} catch (error) {
  failures.push(`threw: ${error?.stack ?? error}`);
  log(`ERROR ${error?.stack ?? error}`);
} finally {
  stopHelper();
  log(`# failures: ${failures.length}`);
  for (const failure of failures) log(`  - ${failure}`);
  writeFileSync(logPath, `${logLines.join("\n")}\n`);
  log(`# evidence: ${outDir}`);
  exitCode = failures.length === 0 ? 0 : 1;
}
process.exit(exitCode);
