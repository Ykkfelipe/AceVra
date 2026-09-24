#!/usr/bin/env node
// Signed ARM64 CUA-3 acceptance against a local, disposable AppKit fixture.
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { callBrokerMethod, resolveExpectedHelperIdentifiers } from "../../broker.js";
import {
  buildHostConnectOpenArgs,
  createCuaBrokerHost,
  readDesignatedRequirement,
} from "../../host-transport.js";

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const helperApp = "/Applications/AceVra Computer Use Dev.app";
const peerProbe =
  process.env.CUA_PEER_PROBE ??
  "/Users/felipemore/.zcode-fork-cua-home/.zcode/computer-use/dev/peer-identity-probe";
const physical = process.argv.includes("--physical");
const temp = await mkdtemp("/tmp/acua3-");
const fixtureApp = join(temp, "CUA-3 Fixture.app");
const fixtureBinary = join(fixtureApp, "Contents/MacOS/ForegroundFixture");
let fixturePid;
let host;
let helperProcess;
const keepTemp = process.env.CUA_FOREGROUND_KEEP_TEMP === "1";
const directLaunch = process.env.CUA_FOREGROUND_DIRECT === "1";

const pause = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const appStatus = (tree, text) =>
  tree?.tree?.elements?.some((element) => element.value === text || element.label === text);
const elementWith = (tree, identifier) =>
  tree?.tree?.elements?.find((element) => element.identifier === identifier);
const center = (frame) => ({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 });

try {
  await mkdir(dirname(fixtureBinary), { recursive: true });
  await writeFile(
    join(fixtureApp, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.acevra.cua3.fixture</string><key>CFBundleExecutable</key><string>ForegroundFixture</string><key>CFBundleName</key><string>CUA-3 Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>12.0</string></dict></plist>`,
  );
  await execFile("xcrun", [
    "swiftc",
    "-parse-as-library",
    "-O",
    "-swift-version",
    "5",
    "-target",
    "arm64-apple-macos12.0",
    "-framework",
    "AppKit",
    "-o",
    fixtureBinary,
    join(here, "evidence/ForegroundFixture.swift"),
  ]);
  await execFile("/usr/bin/open", ["-n", fixtureApp]);
  await pause(700);

  const [hostRequirement, helperRequirement, peerProbeRequirement] = await Promise.all([
    readDesignatedRequirement(process.execPath, execFile),
    readDesignatedRequirement(helperApp, execFile),
    readDesignatedRequirement(peerProbe, execFile),
  ]);
  assert.ok(
    hostRequirement && helperRequirement && peerProbeRequirement,
    "all three code signing requirements must resolve",
  );
  assert.match(helperRequirement, /certificate root/);
  host = createCuaBrokerHost({
    dataRoot: temp,
    expectedHelperIdentifiers: resolveExpectedHelperIdentifiers(),
    launchContract: {
      hostRequirement,
      helperRequirement,
      observationDir: join(temp, "observations"),
      idleMs: 60_000,
    },
    peerProbePath: peerProbe,
    peerProbeRequirement,
  });
  await host.start();
  const openArgs = buildHostConnectOpenArgs({
    appPath: helperApp,
    socketPath: host.socketPath,
    launchToken: host.token,
    hostRequirement,
    helperRequirement,
    observationDir: join(temp, "observations"),
    idleMs: 60_000,
  });
  const helperStdout = join(temp, "helper.stdout");
  const helperStderr = join(temp, "helper.stderr");
  if (directLaunch) {
    helperProcess = spawn(
      join(helperApp, "Contents/MacOS/AceVraComputerUseDev"),
      openArgs.slice(openArgs.indexOf("--args") + 1),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = [];
    helperProcess.stdout.on("data", (chunk) => output.push(chunk));
    helperProcess.stderr.on("data", (chunk) => output.push(chunk));
    helperProcess.on("exit", (code, signal) => {
      if (!host?.helperConnected) {
        process.stderr.write(
          `HELPER_EXIT code=${code} signal=${signal} ${Buffer.concat(output)}\n`,
        );
      }
    });
  } else {
    await execFile("/usr/bin/open", [
      "-n",
      "--stdout",
      helperStdout,
      "--stderr",
      helperStderr,
      ...openArgs,
    ]);
  }
  for (let i = 0; i < 150 && !host.helperConnected; i++) await pause(100);
  if (!host.helperConnected) {
    const stderr = directLaunch ? "" : await readFile(helperStderr, "utf8").catch(() => "");
    throw new Error(`signed Helper peer was not admitted: ${stderr.trim() || "no Helper stderr"}`);
  }
  process.stdout.write(`HELPER admitted pid=${host.admittedHelper.pid}\n`);

  const call = (method, params = {}) =>
    callBrokerMethod({
      socketPath: host.socketPath,
      token: host.token,
      method,
      params,
      timeoutMs: 8000,
    });
  const windows = (await call("list_windows")).windows;
  const window = windows.find((item) => item.title === "AceVra CUA-3 Fixture");
  assert.ok(window, "fixture window must be visible to signed Helper");
  fixturePid = window.pid;
  const target = {
    pid: fixturePid,
    window_id: window.window_id,
    include_image: false,
    include_tree: true,
  };
  const observe = async () => {
    const result = await call("observe", target);
    assert.equal(result.tree?.ok, true, "AX observation must succeed");
    assert.ok(result.foreground_geometry?.observation_id, "fresh geometry is required");
    return result;
  };
  const owner = { owner_session: `fixture-${randomUUID()}`, owner_task: "live" };
  const release = async (lease_id) => {
    const result = await call("release_control", { ...owner, lease_id });
    assert.equal(result.effect, "confirmed", `release: ${result.code ?? result.effect}`);
    assert.equal(result.lease_state, "released", "release must report the terminal state");
  };
  const acquire = async (observation) => {
    const result = await call("acquire_control", {
      ...owner,
      observation_id: observation.foreground_geometry.observation_id,
    });
    assert.equal(result.effect, "confirmed", `acquire: ${result.code ?? result.effect}`);
    return result.lease_id;
  };
  const action = async (method, lease_id, observation, params = {}) => {
    const result = await call(method, {
      ...owner,
      lease_id,
      observation_id: observation.foreground_geometry.observation_id,
      ...params,
    });
    process.stdout.write(
      `${method}: ${JSON.stringify({
        effect: result.effect,
        delivery: result.input_delivery,
        application: result.application_effect,
        code: result.code,
        lease_state: result.lease_state,
        ...(result.effect === "unknown" ? { evidence: result.evidence } : {}),
      })}\n`,
    );
    return result;
  };

  const first = await observe();
  const button = elementWith(first, "cua.click.button");
  assert.ok(button?.frame, "button AX frame");
  let lease = await acquire(first);
  let activated = await action("activate_target", lease, first);
  assert.equal(activated.effect, "confirmed");
  let moved = await action("move_pointer", lease, first, { point: center(button.frame) });
  assert.equal(moved.effect, "confirmed", "pointer must arrive");
  let clicked = await action("click", lease, first, { point: center(button.frame) });
  assert.equal(clicked.input_delivery, "confirmed");
  assert.equal(clicked.application_effect, "confirmed");
  assert.equal(appStatus(await observe(), "clicked"), true);
  await release(lease);
  await release(lease);

  const textObservation = await observe();
  const field = elementWith(textObservation, "cua.text.field");
  assert.ok(field?.frame, "text field AX frame");
  lease = await acquire(textObservation);
  activated = await action("activate_target", lease, textObservation);
  assert.equal(activated.effect, "confirmed");
  await action("click", lease, textObservation, { point: center(field.frame) });
  const focusedObservation = await observe();
  const typed = await action("type_text", lease, focusedObservation, {
    text: "CUA3 deterministic text",
  });
  const typedReadback = elementWith(await observe(), "cua.text.field")?.value;
  assert.equal(
    typed.application_effect,
    "confirmed",
    `text must read back exactly: ${JSON.stringify(typedReadback)}`,
  );
  assert.ok(
    !JSON.stringify(typed.evidence).includes("CUA3 deterministic text"),
    "generic evidence must not include typed content",
  );
  assert.equal(typedReadback, "CUA3 deterministic text");
  await release(lease);

  const keyObservation = await observe();
  const keyTarget = elementWith(keyObservation, "cua.key.target");
  assert.ok(keyTarget?.frame, "key target AX frame");
  lease = await acquire(keyObservation);
  await action("activate_target", lease, keyObservation);
  await action("click", lease, keyObservation, { point: center(keyTarget.frame) });
  const keyFocused = await observe();
  const key = await action("key_press", lease, keyFocused, { key: "space", modifiers: [] });
  assert.equal(key.application_effect, "confirmed");
  assert.equal(appStatus(await observe(), "space pressed"), true);
  await release(lease);

  const scrollObservation = await observe();
  const scrollView = scrollObservation.tree.elements.find(
    (element) => element.role === "AXScrollArea" && element.frame,
  );
  assert.ok(scrollView?.frame, "scroll AX frame");
  lease = await acquire(scrollObservation);
  await action("activate_target", lease, scrollObservation);
  await action("click", lease, scrollObservation, { point: center(scrollView.frame) });
  const scrollReady = await observe();
  const scroll = await action("scroll", lease, scrollReady, {
    point: center(scrollView.frame),
    delta_x: 0,
    delta_y: 180,
  });
  assert.equal(scroll.input_delivery, "confirmed");
  assert.equal(scroll.application_effect, "confirmed");
  await release(lease);

  const dragObservation = await observe();
  const slider = elementWith(dragObservation, "cua.drag.slider");
  assert.ok(slider?.frame, "slider AX frame");
  lease = await acquire(dragObservation);
  await action("activate_target", lease, dragObservation);
  const drag = await action("drag", lease, dragObservation, {
    start: { x: slider.frame.x + 12, y: slider.frame.y + slider.frame.h / 2 },
    end: { x: slider.frame.x + slider.frame.w - 12, y: slider.frame.y + slider.frame.h / 2 },
  });
  assert.equal(drag.input_delivery, "confirmed");
  assert.equal(drag.application_effect, "confirmed");
  await release(lease);

  if (physical) {
    const observation = await observe();
    lease = await acquire(observation);
    await action("activate_target", lease, observation);
    process.stdout.write("READY_FOR_PHYSICAL_INPUT: move the real mouse or press a key now\n");
    const began = Date.now();
    let outcome;
    for (let i = 0; i < 400; i++) {
      await pause(25);
      outcome = await call("control_status", { lease_id: lease });
      if (outcome.lease_state === "interrupted") break;
      if (outcome.lease_state !== "active") {
        throw new Error(`lease ended without a physical event: ${outcome.lease_state}`);
      }
    }
    assert.equal(outcome?.lease_state, "interrupted", "physical input must interrupt");
    process.stdout.write(
      `PHYSICAL interruption observed within ${Date.now() - began} ms polling bound\n`,
    );
  }
  process.stdout.write("CUA-3 signed ARM64 acceptance PASS\n");
} finally {
  await host?.stop().catch(() => undefined);
  if (helperProcess?.exitCode === null) helperProcess.kill("SIGTERM");
  if (Number.isInteger(fixturePid)) {
    try {
      process.kill(fixturePid, "SIGTERM");
    } catch {}
  }
  await pause(100);
  if (keepTemp) process.stdout.write(`CUA_FOREGROUND_TEMP=${temp}\n`);
  else await rm(temp, { recursive: true, force: true });
}
