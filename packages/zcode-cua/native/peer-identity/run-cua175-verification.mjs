#!/usr/bin/env node
/* eslint-disable max-lines -- keeps the complete native acceptance matrix and evidence flow together. */
// CUA-1.75 live evidence: the admitted Helper connection is bound to the native peer identity.
//
// Usage: node packages/zcode-cua/native/peer-identity/run-cua175-verification.mjs [--out DIR]
//
// Drives the acceptance matrix from specs/computer-use.md, "Acceptance for CUA-1.75", on macOS
// with the real signed dev Helper and the real peer-identity probe:
//
//   1. a genuine Helper connection (LaunchServices launch, real contract) is admitted and
//      serves the four CUA-1 methods through the final transport, envelope intact;
//   6. Helper restart over the SAME session re-runs the full binding and is admitted again;
//   2. a helper-looking peer that fails the pinned requirement (ad-hoc re-signed bundle) is
//      not admitted; the same refusal code is captured live from a raw claimant (case 4),
//      which exercises the identical probe verdict path (identity.verified=false);
//   3. a genuine Helper launched with a different `--require-host-requirement` — including one
//      the host would still satisfy (parenthesized DR) — is not admitted on the launch
//      contract; an attacker-pinned anchor is refused by the helper's own gate (exit 77);
//   4. a fake same-uid client (this Node process speaking the hello wire format, real token,
//      fabricated envelope) is refused on its own kernel identity — refusal line captured;
//   5. stale pids authorize nothing: a claimant quoting the genuine helper's pid is refused,
//      and a connection whose peer already exited cannot be bound at all (probe ENOTCONN);
//   7. observe keeps the CUA-1 result envelope (asserted in case 1);
//   8. actuator names stay unavailable (host hop and relay hop).
//
// Needs the dev helper and the probe built (build-dev-helper.mjs, build-peer-identity-probe.mjs).
// Fails (exit 1) on any check.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  clientMethod as clientMethodOn,
  dropCurrentHelper,
  launchDirect,
  speakHello as speakHelloOn,
} from "./verification-lib.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const { createCuaBrokerHost, hostConnectHelperArgv, buildHostConnectOpenArgs } = await import(
  join(repoRoot, "packages/zcode-cua/host-transport.js")
);
const { isBrokerMethod } = await import(join(repoRoot, "packages/zcode-cua/broker.js"));
const { hasDeliverablePayload, OBSERVE_LIMITS, sanitizeObservationResult, serializedBytes } =
  await import(join(repoRoot, "packages/zcode-cua/observe-result.js"));

const argValue = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;

const CUA_HOME = process.env.ZCODE_CUA_HOME?.trim() || join(homedir(), ".zcode-fork-cua-home");
const ZCODE_HOME = process.env.ZCODE_HOME?.trim() || join(CUA_HOME, ".zcode");
const APP = join(ZCODE_HOME, "computer-use/dev/ZCode Computer Use Dev.app");
const EXE = join(APP, "Contents/MacOS/ZCodeComputerUseDev");
const PROBE = join(ZCODE_HOME, "computer-use/dev/peer-identity-probe");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(
  argValue("--out", join(CUA_HOME, "evidence", `cua175-verification-${stamp}`)),
);
mkdirSync(outDir, { recursive: true });
const runTool = promisify((await import("node:child_process")).execFile);

if (!existsSync(APP) || !existsSync(PROBE)) {
  console.error(
    `[cua175] missing ${existsSync(APP) ? "probe" : "dev helper app"} under ${ZCODE_HOME}` +
      " (build with build-dev-helper.mjs and build-peer-identity-probe.mjs)",
  );
  process.exit(1);
}

const logLines = [];
function log(line) {
  const text = typeof line === "string" ? line : JSON.stringify(line);
  logLines.push(text);
  process.stdout.write(`${text}\n`);
}
const failures = [];
const check = (condition, label, detail) => {
  log(`${condition ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` :: ${detail}` : ""}`);
  if (!condition) failures.push(label);
};
const evidence = (name, object) => {
  writeFileSync(join(outDir, name), `${JSON.stringify(object, null, 2)}\n`);
};
const buildInvariantProbe = () => {
  const probe = join(outDir, "InvariantProbe");
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
      probe,
      join(here, "../cua-helper/evidence/InvariantProbe.swift"),
    ],
    { stdio: "pipe" },
  );
  return probe;
};
const desktopState = (probe) => JSON.parse(execFileSync(probe, { encoding: "utf8" }));
const windowRow = (state, windowId) =>
  state.windows.find((row) => row.window_id === windowId) ?? null;
const rankWithinApp = (state, windowId, pid) => {
  const own = state.windows.filter((row) => row.pid === pid);
  const index = own.findIndex((row) => row.window_id === windowId);
  return index < 0 ? null : index;
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

setTimeout(() => {
  console.error("[cua175] WATCHDOG: verification did not finish in time");
  process.exit(2);
}, 240_000).unref();

// MARK: - Pinned requirements and the production-shaped launch

const { readDesignatedRequirement } = await import(
  join(repoRoot, "packages/zcode-cua/host-transport.js")
);
const helperRequirement = await readDesignatedRequirement(APP, runTool);
if (!helperRequirement) {
  console.error("[cua175] could not read the dev helper's designated requirement");
  process.exit(1);
}
// The probe binary's own requirement, pinned at session start and re-checked before every
// spawn (spec: the probe gate).
const probeRequirement = await readDesignatedRequirement(PROBE, runTool);
if (!probeRequirement) {
  console.error("[cua175] could not read the probe's designated requirement");
  process.exit(1);
}
// The host requirement pins THIS verification driver (the node binary running this script), so
// the genuine Helper accepts the listener it connects to. Measured shape: ad-hoc cdhash.
const selfRequirement = await readDesignatedRequirement(process.execPath, runTool);
if (!selfRequirement) {
  console.error("[cua175] this node binary carries no designated requirement to pin");
  process.exit(1);
}

const OBSERVATION_DIR = join(ZCODE_HOME, "computer-use", "observations");
const launchSpec = (host, hostRequirement = selfRequirement) => ({
  appPath: APP,
  socketPath: host.socketPath,
  launchToken: host.token,
  hostRequirement,
  helperRequirement,
  observationDir: OBSERVATION_DIR,
  idleMs: 15_000,
});

function createSessionHost() {
  return createCuaBrokerHost({
    env: { ZCODE_HOME },
    expectedHelperIdentifiers: ["dev.zcode.cua-helper.dev"],
    launchContract: {
      hostRequirement: selfRequirement,
      helperRequirement,
      observationDir: OBSERVATION_DIR,
      idleMs: 15_000,
    },
    peerProbePath: PROBE,
    peerProbeRequirement: probeRequirement,
  });
}

async function launchViaLaunchServices(host, hostRequirement) {
  try {
    await runTool("/usr/bin/open", buildHostConnectOpenArgs(launchSpec(host, hostRequirement)), {
      timeout: 10_000,
    });
  } catch (error) {
    log(`open reported: ${error.message}`);
  }
  const deadline = Date.now() + 20_000;
  while (!host.helperConnected && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return host.helperConnected;
}

/** Lib helpers bound to the live session under test. */
const speakHello = (host, helloResult) => speakHelloOn(host.socketPath, helloResult);
const clientMethod = (host, method, params) =>
  clientMethodOn(host.socketPath, host.token, method, params);

// MARK: - Case 1: genuine Helper, real launch contract → admitted, four methods served

log(`# CUA-1.75 verification — ${new Date().toISOString()}`);
log(`# helper=${APP}`);
log(`# probe=${PROBE}`);
log(`# helperRequirement=${helperRequirement}`);
log(`# hostRequirement=${selfRequirement}`);

const host = createSessionHost();
await host.start();

const admittedFirst = await launchViaLaunchServices(host);
check(admittedFirst, "case 1: genuine helper admitted through the native peer binding");
evidence("case1-admitted.json", { admitted: host.admittedHelper });
check(
  host.admittedHelper?.identifier === "dev.zcode.cua-helper.dev",
  "case 1: admitted identity is the approved helper identifier",
);

let windowsForObservation = null;
if (host.helperConnected) {
  try {
    const status = await host.callMethod("permission_status");
    evidence("case1-permission_status.json", status);
    check(typeof status === "object", "case 1: permission_status served");
  } catch (error) {
    check(false, "case 1: permission_status served", `${error.code ?? ""} ${error.message}`);
  }
  try {
    const apps = await host.callMethod("list_apps");
    evidence("case1-list_apps.json", apps);
    check(Array.isArray(apps?.apps), "case 1: list_apps served with its envelope");
  } catch (error) {
    check(false, "case 1: list_apps served", `${error.code ?? ""} ${error.message}`);
  }
  try {
    const windows = await host.callMethod("list_windows");
    evidence("case1-list_windows.json", windows);
    windowsForObservation = windows;
    check(
      windows?.route === "windowserver" && typeof windows.effect === "string",
      "case 1: list_windows served with its envelope",
    );
  } catch (error) {
    check(false, "case 1: list_windows served", `${error.code ?? ""} ${error.message}`);
  }

  const invariantProbe = buildInvariantProbe();
  const before = desktopState(invariantProbe);
  const helperPid = host.admittedHelper?.pid;
  const candidates = (windowsForObservation?.windows ?? []).filter(
    (row) => row.pid !== before.frontmost.pid && row.pid !== helperPid && row.pid > 0,
  );
  const target =
    candidates.find((row) => row.title && row.on_screen) ??
    candidates.find((row) => row.title) ??
    candidates[0];
  check(Boolean(target), "case 7: a non-frontmost layer-0 window exists to target");
  if (target) {
    const beforeFrames = countPngs(OBSERVATION_DIR);
    try {
      const observation = await host.callMethod("observe", {
        pid: target.pid,
        window_id: target.window_id,
        include_image: true,
        include_tree: true,
      });
      evidence("case1-observe.json", observation);
      const after = desktopState(invariantProbe);
      const afterFrames = countPngs(OBSERVATION_DIR);
      const { result: modelFacing, redactions, limits } = sanitizeObservationResult(observation);
      evidence("case1-observe-model-facing.json", modelFacing);

      check(
        typeof observation?.route === "string" &&
          typeof observation?.effect === "string" &&
          observation?.delivery?.mode === "background" &&
          Array.isArray(observation?.evidence),
        "case 7: observe keeps the CUA-1 result envelope",
        JSON.stringify({ route: observation?.route, effect: observation?.effect }),
      );
      check(
        observation?.image?.ok === true && observation?.image?.blank === false,
        "case 7: non-frontmost capture is non-blank",
        JSON.stringify(observation?.image),
      );
      check(
        after.frontmost.bundleId === before.frontmost.bundleId &&
          after.frontmost.pid === before.frontmost.pid,
        "case 7: frontmost application unchanged by the capture",
        `${before.frontmost.bundleId} -> ${after.frontmost.bundleId}`,
      );
      check(
        Math.abs(after.cursor.x - before.cursor.x) < 0.5 &&
          Math.abs(after.cursor.y - before.cursor.y) < 0.5,
        "case 7: hardware cursor unchanged by the capture",
        `${JSON.stringify(before.cursor)} -> ${JSON.stringify(after.cursor)}`,
      );
      check(
        Boolean(windowRow(after, target.window_id)) &&
          rankWithinApp(after, target.window_id, target.pid) ===
            rankWithinApp(before, target.window_id, target.pid),
        "case 7: captured window remains present and keeps its app-local rank",
      );
      check(
        afterFrames > beforeFrames,
        "case 7: screenshot remains stored in the session-pinned observation directory",
        `${beforeFrames} -> ${afterFrames}`,
      );
      const modelText = JSON.stringify(modelFacing);
      check(
        !modelText.includes(ZCODE_HOME) && !modelText.includes(homedir()),
        "case 7: model-facing observation carries no host paths",
        JSON.stringify(redactions),
      );
      const elements = modelFacing?.tree?.elements;
      const axStringsBounded =
        Array.isArray(elements) &&
        elements.every(
          (element) =>
            ["role", "label", "value", "identifier"].every(
              (key) =>
                typeof element[key] !== "string" ||
                element[key].length <= OBSERVE_LIMITS.maxStringCharacters + 1,
            ) &&
            (!Array.isArray(element.actions) ||
              element.actions.length <= OBSERVE_LIMITS.maxActionsPerElement),
        );
      check(
        modelFacing?.tree?.ok === true &&
          Array.isArray(elements) &&
          elements.length <= OBSERVE_LIMITS.maxElements &&
          axStringsBounded &&
          serializedBytes(modelFacing) <= OBSERVE_LIMITS.maxResultBytes &&
          !limits.exceededBytes,
        "case 7: AX and model-facing observation stay bounded",
        `elements=${elements?.length ?? "n/a"} bytes=${serializedBytes(modelFacing)}`,
      );
      check(
        !hasDeliverablePayload(modelFacing) &&
          typeof modelFacing?.image?.reference === "string" &&
          modelFacing.image.reference.startsWith("helper-observation:") &&
          !("path" in (modelFacing?.image ?? {})) &&
          !("base64" in (modelFacing?.image ?? {})),
        "case 7: observation screenshot is referenced but not deliverable",
      );
    } catch (error) {
      check(false, "case 1: observe served", `${error.code ?? ""} ${error.message}`);
    }
  }

  // Case 8 (host hop): actuator names stay unavailable.
  for (const method of [
    "click",
    "left_click",
    "type_text",
    "move_mouse",
    "press_key",
    "scroll",
    "drag",
    "set_value",
    "launch_app",
  ]) {
    if (isBrokerMethod(method)) {
      check(false, `case 8: ${method} must not be a registered broker method`);
      continue;
    }
    try {
      await host.callMethod(method, {});
      check(false, `case 8: ${method} refused`);
    } catch (error) {
      check(error.code === "not_authorized", `case 8: ${method} refused`, error.code);
    }
  }

  // The production client hop: a token-bearing client through the relay.
  try {
    const status = await clientMethod(host, "permission_status");
    check(typeof status === "object", "case 1: token-bearing client reaches the helper via relay");
  } catch (error) {
    check(false, "case 1: token-bearing client through the relay", error.message);
  }
  try {
    await clientMethod(host, "type_text", { text: "nope" });
    check(false, "case 8: actuator refused on the relay hop");
  } catch (error) {
    check(error.code === "not_authorized", "case 8: actuator refused on the relay hop", error.code);
  }
}

// MARK: - Case 6: Helper restart over the SAME session (reconnect)

{
  const firstPid = host.admittedHelper?.pid;
  check(typeof firstPid === "number", "case 6: helper pid recorded for restart");
  await dropCurrentHelper(host);
  check(host.helperConnected === false, "case 6: helper drop observed");
  const readmitted = await launchViaLaunchServices(host);
  check(readmitted, "case 6: helper re-admitted after restart (full binding re-run)");
  evidence("case6-readmitted.json", { admitted: host.admittedHelper });
  if (host.helperConnected) {
    try {
      const apps = await host.callMethod("list_apps");
      check(Array.isArray(apps?.apps), "case 6: restarted helper serves list_apps");
    } catch (error) {
      check(false, "case 6: restarted helper serves list_apps", error.message);
    }
  }
}

// MARK: - Cases 2, 3, 4, 5 need a helper-free session so impostor hellos reach admission

await dropCurrentHelper(host);
check(host.helperConnected === false, "cases 2-5: session has no admitted helper");

// MARK: - Case 2: re-signed (wrong-signer) helper bundle is not admitted

const resignedApp = join(outDir, "resigned", "ZCode Computer Use Dev.app");
{
  mkdirSync(dirname(resignedApp), { recursive: true });
  spawnSync("/usr/bin/ditto", [APP, resignedApp]);
  const resign = spawnSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    resignedApp,
  ]);
  check(resign.status === 0, "case 2: ad-hoc re-signed helper copy prepared");
  // The probe gate must refuse the ad-hoc binary live: same identifier, different (ad-hoc)
  // signature — this asserts the adhoc refusal fires against REAL codesign output (whose
  // display stream routing the gate must handle).
  const { verifyPeerProbe } = await import(join(repoRoot, "packages/zcode-cua/host-transport.js"));
  // The probe gate must refuse an ad-hoc probe live: same identifier as the real probe, but
  // ad-hoc signed — this asserts the adhoc refusal fires against REAL codesign output (whose
  // display stream routing the gate has to handle; codesign writes it to stderr).
  const adhocProbe = PROBE + ".adhoc-copy";
  spawnSync("/bin/cp", [PROBE, adhocProbe]);
  const adhocSign = spawnSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--identifier",
    "dev.zcode.cua-peer-identity.dev",
    adhocProbe,
  ]);
  check(adhocSign.status === 0, "case 2: ad-hoc probe copy signed successfully");
  const adhocProbeRefused = !(await verifyPeerProbe(adhocProbe, probeRequirement, runTool));
  check(
    adhocProbeRefused,
    "case 2: ad-hoc signed probe refused by the gate (live codesign output)",
  );
  rmSync(adhocProbe, { force: true });
  const outcome = await launchDirect([
    join(resignedApp, "Contents/MacOS/ZCodeComputerUseDev"),
    ...hostConnectHelperArgv(launchSpec(host)),
  ]);
  evidence("case2-resigned-launch.json", outcome);
  check(
    host.helperConnected === false && host.admittedHelper === null,
    "case 2: wrong-signer peer refused (probe identity verdict: verified=false)",
    `helper exit=${outcome.code}`,
  );
}

// MARK: - Case 3: genuine Helper launched with a different host requirement

{
  // (a) a requirement the host would ALSO satisfy (parenthesized DR) — textual equality is
  // the rule, so the launch contract must refuse it.
  const outcomeA = await launchDirect([
    EXE,
    ...hostConnectHelperArgv(launchSpec(host, `(${selfRequirement})`)),
  ]);
  evidence("case3a-parenthesized.json", outcomeA);
  check(
    host.helperConnected === false && host.admittedHelper === null,
    "case 3a: parenthesized host requirement refused on the launch contract",
    `helper exit=${outcomeA.code}`,
  );
  // (b) a completely different anchor: the helper's own gate must refuse the listener.
  const outcomeB = await launchDirect([
    EXE,
    ...hostConnectHelperArgv(launchSpec(host, 'identifier "com.attacker.host"')),
  ]);
  evidence("case3b-attacker-anchor.json", outcomeB);
  check(
    outcomeB.code !== 0,
    "case 3b: helper refuses a listener that does not satisfy the attacker-pinned requirement",
    `exit=${outcomeB.code}`,
  );
}

// MARK: - Case 4: fake same-uid client with the real token and a fabricated envelope

{
  const refusal = await speakHello(host, {
    transport: "host-connect",
    launch_token: host.token,
    helper_identity: {
      verified: true,
      identifier: "dev.zcode.cua-helper.dev",
      cd_hash: "f".repeat(64),
      ad_hoc: false,
      pid: process.pid,
    },
    pid: process.pid,
  });
  evidence("case4-refusal.json", refusal);
  check(
    refusal?.code === "helper_identity_unverified",
    "case 4: fake same-uid client (real token, fabricated envelope) refused on its own identity",
    JSON.stringify(refusal),
  );
}

// MARK: - Case 5: stale / borrowed pids authorize nothing

{
  const genuinePid = 999_999; // a pid that is not this claimant's; quoting cannot help
  const refusal = await speakHello(host, {
    transport: "host-connect",
    launch_token: host.token,
    helper_identity: {
      verified: true,
      identifier: "dev.zcode.cua-helper.dev",
      ad_hoc: false,
      pid: genuinePid,
    },
    pid: genuinePid,
  });
  evidence("case5a-refusal.json", refusal);
  check(
    refusal !== null && refusal.code.startsWith("helper_identity"),
    "case 5a: quoting another process's pid does not authorize an impostor",
    JSON.stringify(refusal),
  );

  // 5b: a connection whose peer already exited cannot be bound at all — measured through the
  // real probe on a throwaway endpoint (the host's own accepted fd is not externally visible).
  const staleProbe = await new Promise((resolveStale) => {
    // Short path on purpose: macOS's sockaddr_un holds 104 bytes of path including the NUL.
    const dir = mkdtempSync(join("/tmp", "cua175-stale-"));
    const path = join(dir, "s.sock");
    const server = createServer();
    server.listen(path, () => {
      const acceptedP = new Promise((resolveAccepted) =>
        server.once("connection", resolveAccepted),
      );
      const child = spawn(process.execPath, [
        "-e",
        `import net from "node:net";const c=net.connect(${JSON.stringify(path)});c.on("connect",()=>{c.write("x");setTimeout(()=>process.exit(0),50)})`,
      ]);
      child.on("error", () => resolveStale({ code: -1, out: "child spawn failed" }));
      child.on("exit", async () => {
        const accepted = await acceptedP;
        // Capture the fd before anything can close the handle; the kernel-side disconnect from
        // the peer's exit is visible to the probe's getsockopt regardless of userspace reads.
        const acceptedFd = accepted._handle?.fd;
        await new Promise((resolveGap) => setTimeout(resolveGap, 300));
        const probe = spawn(PROBE, ["--socket-fd", "3", "--requirement", helperRequirement], {
          stdio: ["ignore", "pipe", "pipe", acceptedFd],
        });
        let out = "";
        probe.stdout.on("data", (chunk) => (out += chunk));
        probe.on("close", (code) => {
          accepted.destroy();
          server.close();
          rmSync(dir, { recursive: true, force: true });
          resolveStale({ code, out: out.trim() });
        });
      });
    });
  });
  evidence("case5b-stale-probe.json", staleProbe);
  check(
    staleProbe.code !== 0 && staleProbe.out.includes("peer_token_unavailable"),
    "case 5b: a peer that exited yields no binding (ENOTCONN, fail closed)",
    staleProbe.out.slice(0, 160),
  );
}

// MARK: - Recovery: the session still admits the genuine helper after all refusals

{
  const recovered = await launchViaLaunchServices(host);
  check(recovered, "recovery: genuine helper admitted again after impostor refusals");
  if (host.helperConnected) {
    try {
      const apps = await host.callMethod("list_apps");
      check(Array.isArray(apps?.apps), "recovery: list_apps served after refusals");
    } catch (error) {
      check(false, "recovery: list_apps served after refusals", error.message);
    }
  }
}

await host.stop();
log(`evidence=${outDir}`);
if (failures.length > 0) {
  log(`FAILURES (${failures.length}):`);
  for (const failure of failures) log(`  - ${failure}`);
  process.exit(1);
}
log("ALL CHECKS PASSED");
process.exit(0);
