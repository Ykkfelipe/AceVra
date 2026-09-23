#!/usr/bin/env node
// CUA-1.5 live evidence: the four observe-only methods driven through the FINAL hardened
// transport — host-owned session socket, Helper in --connect mode, per-launch capability token —
// plus the acceptance checks the mission names.
//
// Usage: node packages/zcode-cua/native/cua-helper/run-cua15-verification.mjs [--out DIR]
//
// What it drives, and why it is this and not a unit test:
//
//  * the hardened launch path end to end: `codesign -d -r-`-pinned requirements, host session
//    creation (0700/0600), LaunchServices launch with --connect, hello admission (token +
//    host-derived codesign validation), all against the real signed dev helper;
//  * the *production client* — `callBrokerMethod` with the capability token, the same function
//    an agent process calls — so the client-side identity envelope check still holds through
//    the relay;
//  * the observe-only boundary through the relay (mutating names refused, unauthenticated
//    clients refused, malformed lines fail closed);
//  * one genuine non-frontmost window capture with the same desktop invariants as CUA-1
//    (frontmost app, hardware cursor, target rank unchanged);
//  * Helper restart over the SAME session (reconnect), which is the property the transport
//    flip must not break.
//
// Needs the dev helper built (build-dev-helper.mjs). Fails (exit 1) on any check.

import { execFileSync, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const { callBrokerMethod, resolveExpectedHelperIdentifiers } = await import(
  join(repoRoot, "packages/zcode-cua/broker.js")
);
const { sanitizeObservationResult } = await import(
  join(repoRoot, "packages/zcode-cua/observe-result.js")
);
const { createCuaBrokerHost, buildHostConnectOpenArgs, readDesignatedRequirement } = await import(
  join(repoRoot, "packages/zcode-cua/host-transport.js")
);
const { promisify } = await import("node:util");

const argValue = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;

const CUA_HOME = process.env.ZCODE_CUA_HOME?.trim() || join(homedir(), ".zcode-fork-cua-home");
const ZCODE_HOME = process.env.ZCODE_HOME?.trim() || join(CUA_HOME, ".zcode");
const APP = join(ZCODE_HOME, "computer-use/dev/ZCode Computer Use Dev.app");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(
  argValue("--out", join(CUA_HOME, "evidence", `cua15-verification-${stamp}`)),
);
mkdirSync(outDir, { recursive: true });

const logLines = [];
function log(line) {
  const text = typeof line === "string" ? line : JSON.stringify(line);
  logLines.push(text);
  process.stdout.write(`${text}\n`);
}
const check = (condition, label, detail) => {
  log(`${condition ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` :: ${detail}` : ""}`);
  if (!condition) failures.push(label);
};
const failures = [];

if (!existsSync(APP)) {
  console.error(`[cua15] dev helper app missing: ${APP} (build it with build-dev-helper.mjs)`);
  process.exit(1);
}

const runTool = promisify((await import("node:child_process")).execFile);

// MARK: - Invariant probe (same instrument the CUA-1 harness uses)

function buildInvariantProbe() {
  const out = join(outDir, "InvariantProbe");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-O",
      "-swift-version",
      "5",
      "-target",
      "arm64-apple-macos12.0",
      "-framework",
      "CoreGraphics",
      "-framework",
      "AppKit",
      "-o",
      out,
      join(here, "evidence/InvariantProbe.swift"),
    ],
    { stdio: "pipe" },
  );
  return out;
}
const desktopState = (probe) => JSON.parse(execFileSync(probe, { encoding: "utf8" }));
const windowRow = (state, windowId) =>
  state.windows.find((row) => row.window_id === windowId) ?? null;
const rankWithinApp = (state, windowId, pid) => {
  const own = state.windows.filter((row) => row.pid === pid);
  return own.findIndex((row) => row.window_id === windowId);
};
const countPngs = (directory) => {
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
};

// MARK: - Raw-socket helpers (relay-level checks the client function cannot express)

function rawRequest(socketPath, line, { timeoutMs = 3000 } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection({ path: socketPath });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      rejectRequest(new Error("raw request timed out"));
    }, timeoutMs);
    socket.on("error", (error) => {
      clearTimeout(timer);
      rejectRequest(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolveRequest(JSON.parse(buffer.slice(0, index)));
      } catch (error) {
        rejectRequest(error);
      }
    });
    socket.on("connect", () => socket.write(line));
  });
}

// MARK: - Verification

const hostRequirement = await readDesignatedRequirement(process.execPath, runTool);
check(Boolean(hostRequirement), "host designated requirement resolved from the running image");
const helperRequirement = await readDesignatedRequirement(APP, runTool);
check(
  Boolean(helperRequirement) && helperRequirement.includes("certificate root"),
  "helper requirement is certificate-anchored (bundle id alone would not be an anchor)",
  helperRequirement,
);

const host = createCuaBrokerHost({
  env: process.env,
  installRoots: [join(ZCODE_HOME, "computer-use")],
  helperRequirement,
  expectedHelperIdentifiers: resolveExpectedHelperIdentifiers(),
});
await host.start();
check(existsSync(host.socketPath), "host session socket exists");
const { statSync, chmodSync: chmodUnused } = await import("node:fs");
check((statSync(host.socketPath).mode & 0o777) === 0o600, "session socket mode is 0600");
check((statSync(host.sessionDir).mode & 0o777) === 0o700, "session directory mode is 0700");

const args = buildHostConnectOpenArgs({
  appPath: APP,
  socketPath: host.socketPath,
  launchToken: host.token,
  hostRequirement,
  helperRequirement,
  observationDir: join(ZCODE_HOME, "computer-use/observations"),
  idleMs: 60_000,
});
log(`launch=${JSON.stringify(["/usr/bin/open", "-n", ...args])}`);
await runTool("/usr/bin/open", ["-n", ...args], { timeout: 5_000 }).catch(() => undefined);

const admissionDeadline = Date.now() + 15_000;
while (!host.helperConnected && Date.now() < admissionDeadline) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
}
check(host.helperConnected, "helper admitted over the host-owned socket");
check(
  Boolean(host.admittedHelper?.pid),
  "admission recorded the helper pid",
  JSON.stringify(host.admittedHelper),
);
const helperPid = host.admittedHelper?.pid;

// Substitution direction: a FAKE listener cannot be served because the helper verifies the
// host — exercised from the other side here: the helper connected to THIS host, which passed
// its pinned requirement. A wrong-requirement host is measured by run-identity-probe.sh cases.
// What is provable from Node: an impostor helper (wrong token) cannot be admitted at all.
const impostor = await rawRequest(
  host.socketPath,
  `${JSON.stringify({
    ok: true,
    result: {
      type: "helper_hello",
      transport: "host-connect",
      launch_token: "wrong-token",
      helper_identity: {
        verified: true,
        identifier: "dev.zcode.cua-helper.dev",
        ad_hoc: false,
      },
      pid: helperPid,
    },
  })}\n`,
).catch(() => null);
check(impostor === null || impostor?.ok === false, "impostor hello (wrong token) is not admitted");

// Session capability: discovering the socket buys nothing.
const unauthenticated = await rawRequest(
  host.socketPath,
  `${JSON.stringify({ id: "x", method: "observe", params: { pid: 1 } })}\n`,
).catch(() => null);
check(
  unauthenticated?.ok === false && unauthenticated?.error?.code === "missing_session_capability",
  "a client without the capability token is refused",
);
const wrongToken = await rawRequest(
  host.socketPath,
  `${JSON.stringify({ id: "x", method: "observe", params: { pid: 1 }, token: "nope" })}\n`,
).catch(() => null);
check(
  wrongToken?.ok === false && wrongToken?.error?.code === "wrong_caller",
  "a wrong token is refused",
);
const mutating = await rawRequest(
  host.socketPath,
  `${JSON.stringify({ id: "x", method: "left_click", token: host.token })}\n`,
).catch(() => null);
check(
  mutating?.ok === false && mutating?.error?.code === "not_authorized",
  "a mutating name is refused by the relay",
);
const malformed = await rawRequest(host.socketPath, "this is not json\n").catch(() => null);
check(
  malformed?.ok === false && malformed?.error?.code === "bad_request",
  "a malformed line is answered bad_request",
);
const errorText = JSON.stringify([unauthenticated, wrongToken, mutating, malformed]);
check(
  !errorText.includes(ZCODE_HOME) && !errorText.includes(host.socketPath),
  "relay refusals carry no host paths",
);

// The four observe-only methods through the production client, with the capability token.
const status = await callBrokerMethod({
  socketPath: host.socketPath,
  method: "permission_status",
  token: host.token,
  timeoutMs: 5_000,
});
const identity = status.helper_identity ?? {};
check(identity.verified === true, "helper identity envelope verified through the relay");
check(
  identity.bundle_validated === true,
  "sealed bundle validated (resources + nested) by the helper's own check",
  `bundle_validated=${identity.bundle_validated}`,
);
check(status.grant_owner === identity.identifier, "grant_owner equals the verified identifier");
log(`accessibility=${status.accessibility} screen_recording=${status.screen_recording}`);

const apps = await callBrokerMethod({
  socketPath: host.socketPath,
  method: "list_apps",
  token: host.token,
  timeoutMs: 8_000,
});
check(Array.isArray(apps.apps) && apps.apps.length > 0, "list_apps answers through the transport");
const windows = await callBrokerMethod({
  socketPath: host.socketPath,
  method: "list_windows",
  token: host.token,
  timeoutMs: 8_000,
});
check(Array.isArray(windows.windows), "list_windows answers through the transport");

// Desktop invariants around one non-frontmost observation.
const probe = buildInvariantProbe();
const before = desktopState(probe);
log(`before.frontmost=${JSON.stringify(before.frontmost)} cursor=${JSON.stringify(before.cursor)}`);
const frontmostPid = before.frontmost.pid;
const candidates = windows.windows.filter(
  (row) => row.pid !== frontmostPid && row.pid !== helperPid && row.pid > 0,
);
const target =
  candidates.find((row) => row.title && row.on_screen) ??
  candidates.find((row) => row.title) ??
  candidates[0];
check(Boolean(target), "a non-frontmost layer-0 window exists to target");
if (target) {
  log(
    `target=${JSON.stringify({ window_id: target.window_id, pid: target.pid, owner: target.owner })}`,
  );
  const observation = await callBrokerMethod({
    socketPath: host.socketPath,
    method: "observe",
    params: {
      pid: target.pid,
      window_id: target.window_id,
      include_image: true,
      include_tree: true,
    },
    token: host.token,
    timeoutMs: 30_000,
  });
  log(`observe.effect=${observation.effect} route=${observation.route}`);
  log(`observe.image=${JSON.stringify(observation.image)}`);
  check(
    observation.effect === "confirmed" || observation.effect === "partial",
    "observation returns an honest effect (confirmed or partial), never invented success",
    observation.effect,
  );
  const after = desktopState(probe);
  log(`after.frontmost=${JSON.stringify(after.frontmost)} cursor=${JSON.stringify(after.cursor)}`);
  check(
    after.frontmost.bundleId === before.frontmost.bundleId &&
      after.frontmost.pid === before.frontmost.pid,
    "frontmost application unchanged by the observation",
  );
  check(
    Math.abs(after.cursor.x - before.cursor.x) < 0.5 &&
      Math.abs(after.cursor.y - before.cursor.y) < 0.5,
    "hardware cursor unchanged by the observation",
  );
  check(
    rankWithinApp(after, target.window_id, target.pid) ===
      rankWithinApp(before, target.window_id, target.pid),
    "target window keeps its rank inside its own application",
  );
  check(
    Boolean(windowRow(after, target.window_id)),
    "target window still present after the observation",
  );
  // The observation store used is the one the launch args pinned — the fork's data root.
  const frames = countPngs(join(ZCODE_HOME, "computer-use/observations"));
  check(
    frames > 0,
    "the frame landed in the session-pinned observation directory",
    `frames=${frames}`,
  );
  const { result: modelFacing } = sanitizeObservationResult(observation);
  const modelText = JSON.stringify(modelFacing);
  check(!modelText.includes(ZCODE_HOME), "model-facing observation carries no host paths");
}

// Actuator boundary through the runtime map: every mutating name resolves to the unavailable
// marker (never a broker call, never success). That is the CUA-1 contract, unchanged.
const runtime = (
  await import(join(repoRoot, "packages/zcode-cua/index.js"))
).createComputerUseRuntime();
const actuatorNames = ["left_click", "type", "key", "scroll", "drag", "set_value", "launch_app"];
for (const name of actuatorNames) {
  const outcome = await runtime.execute({ toolName: name, arguments: {} });
  const refused =
    outcome?.isError === true &&
    typeof outcome?.content?.[0]?.text === "string" &&
    outcome.content[0].text.includes("not available");
  check(
    refused,
    `actuator '${name}' stays unavailable through the runtime`,
    JSON.stringify(outcome).slice(0, 140),
  );
}

// Restart over the same session: kill the helper, relaunch into the SAME socket/token, prove the
// transport reconnects and the identity envelope still verifies.
if (helperPid) {
  try {
    process.kill(helperPid, "SIGTERM");
  } catch {}
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  check(!host.helperConnected, "helper drop observed by the session");
  const relaunched = await host
    .callMethod("permission_status", undefined, { timeoutMs: 3_000 })
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, code: error?.code }),
    );
  check(relaunched.ok === false, "requests during helper absence fail closed", relaunched.code);
  await runTool("/usr/bin/open", ["-n", ...args], { timeout: 5_000 }).catch(() => undefined);
  const reAdmissionDeadline = Date.now() + 15_000;
  while (!host.helperConnected && Date.now() < reAdmissionDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  check(host.helperConnected, "helper re-admitted over the SAME session (reconnect)");
  const afterRestart = await callBrokerMethod({
    socketPath: host.socketPath,
    method: "permission_status",
    token: host.token,
    timeoutMs: 5_000,
  });
  check(
    afterRestart.helper_identity?.verified === true,
    "identity envelope verifies after the restart",
  );
}

await host.stop();
check(!existsSync(host.socketPath), "session socket removed on stop");

writeFileSync(join(outDir, "run.log"), `${logLines.join("\n")}\n`);
log(`evidence=${outDir}`);
if (failures.length > 0) {
  log(`FAILURES: ${failures.length}`);
  process.exit(1);
}
log("CUA-1.5 verification passed");
process.exit(0);
