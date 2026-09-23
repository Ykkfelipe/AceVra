// CUA-1.75 native peer binding — the I/O half of the bridge (the policy half is pure, in
// host-transport-policy.js).
//
// One question per helper admission: "who is on the other end of this accepted socket?" The
// answer is produced by the native peer-identity probe (native/peer-identity), which receives
// the accepted socket as an inherited fd (public `child_process` stdio passthrough — the
// parent fd number in the stdio slot, the child sees it at that slot number) and returns one
// JSON line: kernel audit-token binding + code-signing verification of that exact process
// instance (shared CodeIdentity.swift source with the Helper) + the peer's exec argv.
//
// Failure posture: every failure returns `null`, which admission evaluates as
// `peer_identity_unavailable` — fail closed, never a partial trust (spec "The native probe").

import { spawn } from "node:child_process";

import { verifyPeerProbe } from "./host-transport-policy.js";

/** Upper bound for one probe run: spawn + signature checks + two sysctls. */
const PROBE_TIMEOUT_MS = 5_000;
/** The probe reads the accepted socket at this stdio slot (spec "The native probe"). */
const PROBE_SOCKET_SLOT = 3;

/** codesign runner for the probe's one-time verification, via lazily imported execFile. */
async function defaultRunTool(file, args, runOptions) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)(file, args, runOptions);
}

/**
 * Create the default peer binder for one host session. `probePath` and `gateRequirement` (the
 * probe binary's own designated requirement, pinned at session start) are resolved by the
 * caller; services owns launch inputs. `requirement` is the Helper requirement the probe
 * enforces on the peer. The probe binary is re-verified before every spawn — it is trusted
 * code in the admission chain and lives in a same-uid-writable directory (spec "Remaining
 * limitations").
 *
 * The returned `bind(socket)` resolves to the probe's report object, or `null` when no
 * complete kernel binding could be produced.
 */
export function createPeerIdentityBinder(options = {}) {
  const { probePath, requirement, gateRequirement, runTool = defaultRunTool } = options;

  async function bind(socket) {
    if (typeof probePath !== "string" || probePath.length === 0 || !requirement) return null;
    if (!(await verifyPeerProbe(probePath, gateRequirement ?? requirement, runTool))) return null;
    // `_handle.fd` is Node-internal and the only way to name the accepted socket; without it
    // the probe cannot be handed the connection, and admission must refuse (spec
    // "Remaining limitations" 3 — availability risk, fail closed). The fd is read here,
    // synchronously immediately before the spawn: no await in between, so the fd number cannot
    // be recycled onto a different connection by an interleaved accept.
    const fd = socket?._handle?.fd;
    if (!Number.isInteger(fd) || fd < 0) return null;
    return await runProbe(probePath, fd, requirement);
  }

  return { bind };
}

/**
 * Spawn the probe once for one accepted socket fd and parse its report. `null` on any
 * anomaly: spawn failure, timeout, non-zero exit, malformed or oversized output.
 */
function runProbe(probePath, parentFd, requirement) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(
        probePath,
        ["--socket-fd", String(PROBE_SOCKET_SLOT), "--requirement", requirement],
        {
          stdio: ["ignore", "pipe", "pipe", parentFd],
          timeout: PROBE_TIMEOUT_MS,
        },
      );
    } catch {
      settle(null);
      return;
    }
    let out = "";
    let outBytes = 0;
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      // One JSON line of identity facts — the 64 KiB cap is generous and bounds a hostile or
      // broken probe; responses from the Helper keep their own (much larger) relay caps.
      if (outBytes > 64 * 1024) {
        child.kill("SIGKILL");
        settle(null);
        return;
      }
      out += chunk;
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => {
      if (code !== 0) {
        settle(null);
        return;
      }
      let report;
      try {
        report = JSON.parse(out.trim());
      } catch {
        settle(null);
        return;
      }
      if (!report || typeof report !== "object" || report.ok !== true) {
        settle(null);
        return;
      }
      const pid = report.binding?.pid;
      const peerArgs = report.peer_args;
      if (!Number.isInteger(pid) || pid <= 0 || !Array.isArray(peerArgs) || peerArgs.length === 0) {
        settle(null);
        return;
      }
      // The probe's own kernel cross-checks must have passed: both answers about the peer of
      // THIS socket have to agree, or the binding is not one answer at all.
      if (report.binding?.peerpid_agrees !== true || report.binding?.peercred_agrees !== true) {
        settle(null);
        return;
      }
      settle({
        pid,
        pidversion: Number.isInteger(report.binding?.pidversion) ? report.binding.pidversion : 0,
        binding: report.binding,
        identity: report.identity ?? null,
        peerArgs,
      });
    });
  });
}
