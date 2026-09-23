// CUA-1.5 transport admission policy — the pure half of the host-owned transport.
//
// Split from host-transport.js so the security decisions (token comparison, hello admission,
// requirement discovery, the host-derived helper pid scan) are testable without sockets and the
// relay runtime stays about I/O. Every rule here is specified in
// packages/zcode-cua/specs/computer-use.md, section "CUA-1.5"; the reasoning for the direction
// flip is in that section's "Why the transport direction flips".

import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

/** The hello line the Helper sends before serving anything (spec "Launch contract"). */
export const HELLO_TYPE = "helper_hello";

/**
 * Constant-time byte comparison keyed on SHA-256 digests, so the comparison does not leak the
 * token's length and never throws on unequal lengths (timingSafeEqual requires equal length).
 */
export function tokensMatch(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string" || expected.length === 0) {
    return false;
  }
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Decide whether a `helper_hello` may be admitted as the session's Helper connection.
 *
 * Pure and total so the admission policy is testable without a socket. The caller (the relay)
 * supplies the host-derived facts: the launch token it minted, the expected helper identity
 * list, and the validated-pid set it computed from the process table + `codesign -R` — never
 * from anything the connection said (spec "The host validates the Helper at admission").
 *
 * Stable refusal codes, in check order:
 *   bad_hello                 — not the hello shape
 *   wrong_helper_token        — launch token missing or wrong
 *   helper_identity_*         — envelope verdict (policy/missing/unverified/adhoc/mismatch)
 *   helper_process_unverified — pid not in the host-validated set
 */
export function evaluateHelperHello(hello, policy) {
  const result = hello && typeof hello === "object" ? hello.result : undefined;
  if (!result || typeof result !== "object" || result.type !== HELLO_TYPE) {
    return { admitted: false, code: "bad_hello", reason: "the first line was not a helper hello" };
  }
  if (!tokensMatch(result.launch_token, policy.launchToken)) {
    return {
      admitted: false,
      code: "wrong_helper_token",
      reason: "the helper did not present this session's launch token",
    };
  }
  const identity = result.helper_identity;
  const verdict = evaluateIdentityForAdmission(identity, policy.expectedHelperIdentifiers);
  if (!verdict.verified) {
    return { admitted: false, code: verdict.code, reason: verdict.reason ?? "" };
  }
  const pid = typeof result.pid === "number" && Number.isInteger(result.pid) ? result.pid : 0;
  if (pid <= 0 || !(policy.validatedPids instanceof Set) || !policy.validatedPids.has(pid)) {
    return {
      admitted: false,
      code: "helper_process_unverified",
      reason:
        "the hello's pid is not a live process the host itself validated against the helper " +
        "code requirement",
    };
  }
  return {
    admitted: true,
    code: "ok",
    reason: "",
    pid,
    identifier: verdict.identifier,
    identity,
  };
}

/**
 * The envelope verdict for admission — the same rules, in the same order, as
 * `evaluateHelperIdentity` in broker.js (the client-side check): policy present, identity
 * present, self-verified, non-empty identifier, not ad-hoc, identifier in the expected list.
 * Inlined because admission must stay pure and dependency-light; test/host-transport.test.mjs
 * asserts the two stay in lockstep.
 */
function evaluateIdentityForAdmission(identity, expectedIdentifiers) {
  const expected = Array.isArray(expectedIdentifiers) ? expectedIdentifiers : [];
  if (expected.length === 0) {
    return { verified: false, code: "helper_identity_policy_missing" };
  }
  if (!identity || typeof identity !== "object") {
    return { verified: false, code: "helper_identity_missing" };
  }
  if (identity.verified !== true) {
    return { verified: false, code: "helper_identity_unverified" };
  }
  const identifier = typeof identity.identifier === "string" ? identity.identifier : "";
  if (!identifier) return { verified: false, code: "helper_identity_unverified" };
  if (identity.ad_hoc === true) return { verified: false, code: "helper_identity_adhoc" };
  if (!expected.includes(identifier)) return { verified: false, code: "helper_identity_mismatch" };
  return { verified: true, identifier };
}

/**
 * Cheap pre-flight for a hello line: the shape and launch-token checks from
 * `evaluateHelperHello`, runnable BEFORE the expensive host-derived pid scan so an
 * unauthenticated peer cannot buy subprocess work with a hello-shaped line. A pass does not
 * admit — the full evaluation still runs on the scanned facts.
 */
export function preflightHello(hello, launchToken) {
  const result = hello && typeof hello === "object" ? hello.result : undefined;
  return Boolean(
    result &&
    typeof result === "object" &&
    result.type === HELLO_TYPE &&
    tokensMatch(result.launch_token, launchToken),
  );
}

/** Kernel-verified liveness of one pid (`kill(pid, 0)`). */
export function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `/usr/bin/open` argv for a host-connect launch (spec "Launch contract"). The args travel
 * with the launch because the environment does not cross LaunchServices (measured, CUA-0.5);
 * the observation directory is therefore mandatory here — without it a LaunchServices helper
 * would fall back to the product's `~/.zcode`.
 */
export function buildHostConnectOpenArgs(spec) {
  const required = [
    "appPath",
    "socketPath",
    "launchToken",
    "hostRequirement",
    "helperRequirement",
    "observationDir",
  ];
  for (const key of required) {
    const value = spec?.[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`host-connect launch spec is missing ${key}`);
    }
  }
  return [
    "-a",
    spec.appPath,
    "--args",
    "--connect",
    spec.socketPath,
    "--launch-token",
    spec.launchToken,
    "--require-host-requirement",
    spec.hostRequirement,
    "--expected-requirement",
    spec.helperRequirement,
    "--observation-dir",
    spec.observationDir,
    ...(spec.idleMs ? ["--idle-ms", String(spec.idleMs)] : []),
  ];
}

/** execFile-style runners resolve `{ stdout }`; plain runners resolve a string or Buffer. */
function normalizeToolOutput(output) {
  if (typeof output === "string") return output;
  if (Buffer.isBuffer(output)) return output.toString("utf8");
  if (typeof output?.stdout === "string") return output.stdout;
  if (Buffer.isBuffer(output?.stdout)) return output.stdout.toString("utf8");
  return "";
}

/**
 * Read a code object's designated requirement via `codesign -d -r-`. Returns null when the path
 * carries no signature — the hardened transport refuses to start without a pinned requirement
 * (fail closed; callers fall back to the CUA-1 standalone flow and say why).
 */
export async function readDesignatedRequirement(codePath, runTool) {
  try {
    const output = await runTool("/usr/bin/codesign", ["-d", "-r-", codePath], {
      timeout: 5_000,
    });
    const line = normalizeToolOutput(output)
      .split("\n")
      .find((candidate) => candidate.includes("=>"));
    const requirement = (line ?? "").replace(/^.*?designated\s*=>\s*/, "").trim();
    return requirement || null;
  } catch {
    return null;
  }
}

/**
 * Live processes under the helper install roots whose executable's bundle satisfies the helper
 * requirement — the host-derived "could be our helper" set for hello admission. Deliberately
 * pessimistic (`ps` for discovery, `codesign --verify` for the verdict), so admission never
 * trusts the connection's own claims. `runTool` is injectable for deterministic tests.
 */
export async function collectValidatedHelperPids(options) {
  const { installRoots, requirement, runTool } = options;
  if (!Array.isArray(installRoots) || installRoots.length === 0 || !requirement) return new Set();
  const roots = installRoots.map((root) => resolve(root));
  let listing;
  try {
    listing = normalizeToolOutput(await runTool("/bin/ps", ["-axo", "pid=,comm="]));
  } catch {
    return new Set();
  }
  const candidates = listing
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), executable: match[2] } : null;
    })
    .filter(
      (entry) =>
        entry !== null &&
        entry.pid > 0 &&
        isAbsolute(entry.executable) &&
        roots.some((root) => entry.executable === root || entry.executable.startsWith(`${root}/`)),
    );
  const validated = new Set();
  for (const candidate of candidates) {
    try {
      // `-R=<requirement>` must be one argv element: a detached `-R <req>` is parsed as
      // "check the requirement FILE <req>" and always fails (measured).
      await runTool("/usr/bin/codesign", [
        "--verify",
        "--strict",
        "--all-architectures",
        `-R=${requirement}`,
        candidate.executable,
      ]);
      validated.add(candidate.pid);
    } catch {
      // Not our helper (or a broken seal): excluded from admission.
    }
  }
  return validated;
}
