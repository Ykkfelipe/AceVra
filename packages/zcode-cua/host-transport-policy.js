// CUA-1.75 transport admission policy — the pure half of the host-owned transport.
//
// Split from host-transport.js so the security decisions (token comparison, hello admission,
// peer-binding evaluation, launch-contract equality, requirement discovery) are testable
// without sockets and the relay runtime stays about I/O. Every rule here is specified in
// packages/zcode-cua/specs/computer-use.md, section "CUA-1.75"; the reasoning for the
// direction flip is in CUA-1.5's "Why the transport direction flips".
//
// The CUA-1.5 host-derived pid scan (`ps` + `codesign -R`) is gone on purpose: it proved
// "some validated helper process exists" but could not bind THIS connection to it (spec,
// CUA-1.5 "Remaining limitations" 3a/3b). CUA-1.75 replaces the scan with the native peer
// binding — the kernel names the connected peer instance and the probe verifies its code
// signature — and adds launch-contract equality so a genuine Helper launched by an attacker
// with arguments of their choosing is refused alongside every unverified claimant.

import { createHash, timingSafeEqual } from "node:crypto";

/** The hello line the Helper sends before serving anything (spec "Launch contract"). */
export const HELLO_TYPE = "helper_hello";

/**
 * Signing identifier the peer-identity probe binary must carry in its designated requirement.
 * A collision filter, exactly like the helper identifier list (spec CUA-1 "What the identifier
 * list is and is not"): it refuses an unrelated binary in the probe path, and the real anchor
 * is the probe's own code-signature validation. Kept in lockstep with
 * native/peer-identity/build-peer-identity-probe.mjs by that script's drift guard.
 */
export const PEER_PROBE_IDENTIFIER = "dev.acevra.cua-peer-identity.development";

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
 * supplies the host-derived facts only (spec "The host validates the Helper at admission" as
 * revised by CUA-1.75): the launch token it minted, the expected helper identity list, the
 * helper argv it launched with, and the native peer-binding report computed from the accepted
 * socket itself — never from anything the connection said.
 *
 * `peerBinding` is `null` (or missing its parts) whenever the native probe could not produce
 * a complete kernel binding; that is an answer of "no", not a bypass.
 *
 * Stable refusal codes, in check order:
 *   bad_hello                    — not the hello shape
 *   wrong_helper_token           — launch token missing or wrong
 *   peer_identity_unavailable    — no kernel peer binding for this connection
 *   helper_identity_*            — envelope verdict (policy/missing/unverified/adhoc/mismatch)
 *   helper_process_unverified    — hello pid is not the kernel-bound peer pid
 *   helper_launch_contract_mismatch — peer exec args are not this launch's contract
 */
export function evaluateHelperHello(hello, policy, peerBinding) {
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
  // The kernel binding comes before any identity credit: without "who is on this socket",
  // nothing the hello claims can be attributed to anyone (spec: the chain starts at the
  // connected socket).
  const binding = peerBinding && typeof peerBinding === "object" ? peerBinding : null;
  const bindingPid =
    typeof binding?.pid === "number" && Number.isInteger(binding.pid) && binding.pid > 0
      ? binding.pid
      : 0;
  const peerArgs = Array.isArray(binding?.peerArgs) ? binding.peerArgs : null;
  if (!binding || bindingPid === 0 || !peerArgs || peerArgs.length === 0) {
    return {
      admitted: false,
      code: "peer_identity_unavailable",
      reason:
        "the host could not bind this connection to the peer's kernel identity " +
        "(native peer binding unavailable)",
    };
  }
  const identity = binding.identity;
  const verdict = evaluateIdentityForAdmission(identity, policy.expectedHelperIdentifiers);
  if (!verdict.verified) {
    return { admitted: false, code: verdict.code, reason: verdict.reason ?? "" };
  }
  // Consistency only: the hello's self-reported identity may not contradict the identity the
  // host verified from the peer's own signature. The envelope is never a source of trust.
  const helloIdentity = result.helper_identity;
  if (helloIdentity && typeof helloIdentity === "object") {
    const claimed = typeof helloIdentity.identifier === "string" ? helloIdentity.identifier : "";
    const claimedHash = typeof helloIdentity.cd_hash === "string" ? helloIdentity.cd_hash : "";
    const derivedHash = typeof identity.cd_hash === "string" ? identity.cd_hash : "";
    if (
      (claimed && claimed !== verdict.identifier) ||
      (claimedHash && derivedHash && claimedHash !== derivedHash)
    ) {
      return {
        admitted: false,
        code: "helper_identity_mismatch",
        reason: "the hello's identity claim contradicts the peer's verified signature",
      };
    }
  }
  // The hello's pid stays self-reported (the Helper binary is unchanged); the kernel pid is
  // authoritative. Equality is consistency — a stale, recycled or borrowed pid quoted here
  // can never authorize anything (spec "Admission rules", check 5).
  const helloPid = typeof result.pid === "number" && Number.isInteger(result.pid) ? result.pid : 0;
  if (helloPid !== bindingPid) {
    return {
      admitted: false,
      code: "helper_process_unverified",
      reason:
        "the hello's pid is not the kernel-bound peer of this connection " +
        "(a quoted pid is never consulted for authorization)",
    };
  }
  // Launch-contract equality (spec "Admission rules", check 6): the peer must have exec'd with
  // exactly the arguments the host minted for this launch. This is what refuses a genuine
  // Helper an attacker launched with arguments of their choosing — including a different
  // `--require-host-requirement`, even one the host would still satisfy.
  if (!helperArgvMatches(peerArgs, policy.expectedHelperArgv)) {
    return {
      admitted: false,
      code: "helper_launch_contract_mismatch",
      reason:
        "the peer's exec arguments are not the launch contract this host minted for " +
        "this session",
    };
  }
  return {
    admitted: true,
    code: "ok",
    reason: "",
    pid: bindingPid,
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
 * `evaluateHelperHello`, runnable BEFORE the native peer binding so an unauthenticated peer
 * cannot buy subprocess work with a hello-shaped line. A pass does not admit — the full
 * evaluation still runs on the bound facts.
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

/**
 * The helper-side argv of a host-connect launch — everything after `/usr/bin/open -a <app>
 * --args` (spec "Launch contract"). Single source of the argument spelling: the launch in
 * `buildHostConnectOpenArgs` and the admission-side equality check both consume this, so the
 * two cannot drift. Measured (spec "Measured platform facts"): LaunchServices delivers this
 * tail verbatim as the Helper's `argv[1..]`, with argument boundaries preserved.
 */
export function hostConnectHelperArgv(spec) {
  const required = [
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

/**
 * The `/usr/bin/open` argv for a host-connect launch (spec "Launch contract"). The args travel
 * with the launch because the environment does not cross LaunchServices (measured, CUA-0.5);
 * the observation directory is therefore mandatory here — without it a LaunchServices helper
 * would fall back to the product's `~/.zcode`.
 */
export function buildHostConnectOpenArgs(spec) {
  const appPath = spec?.appPath;
  if (typeof appPath !== "string" || appPath.length === 0) {
    throw new Error("host-connect launch spec is missing appPath");
  }
  return ["-a", appPath, "--args", ...hostConnectHelperArgv(spec)];
}

/**
 * Exact equality between the exec args a connected peer actually launched with and the
 * contract this host minted. `argv[0]` (the exec path) is not part of the contract; everything
 * after it must be the contract's `--flag value` pairs, same names, same values, same count —
 * a missing, extra, duplicated or differently-worded flag is a mismatch (fail closed).
 */
export function helperArgvMatches(peerArgs, expectedArgv) {
  if (!Array.isArray(peerArgs) || !Array.isArray(expectedArgv)) return false;
  const presented = parseFlagValueArgv(peerArgs.slice(1));
  const expected = parseFlagValueArgv(expectedArgv);
  if (presented === null || expected === null) return false;
  if (presented.size !== expected.size) return false;
  for (const [flag, value] of expected) {
    if (presented.get(flag) !== value) return false;
  }
  return true;
}

/** `--flag value` pairs → Map, or null when the shape is not strictly paired flags. */
function parseFlagValueArgv(tokens) {
  if (tokens.length === 0 || tokens.length % 2 !== 0) return null;
  const map = new Map();
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i];
    const value = tokens[i + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || flag.length < 3) return null;
    if (typeof value !== "string" || value.length === 0) return null;
    if (map.has(flag)) return null; // a duplicated flag is not this contract
    map.set(flag, value);
  }
  return map;
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
 * The peer-identity probe's own code-signature gate, before its verdicts are ever trusted.
 * The probe is trusted code in the admission chain (spec "Remaining limitations"), so the
 * binary in the probe path must satisfy ALL of:
 *   1. its on-disk designated requirement EQUALS the requirement pinned at session start
 *      (`expectedRequirement` — read once by the launcher, the same anchoring shape as the
 *      Helper's `helperRequirement`; a binary swapped after that read fails the equality);
 *   2. it carries the expected probe identifier (collision filter, same weight as the helper
 *      identifier list); and
 *   3. it is not ad-hoc signed (`codesign -dv` reports `Signature=adhoc` — refused, exactly
 *      like the helper admission refuses ad-hoc helpers), and its seal validates strictly
 *      against the pinned requirement.
 * `runTool` is injectable for deterministic tests.
 */
export async function verifyPeerProbe(probePath, expectedRequirement, runTool) {
  if (typeof probePath !== "string" || probePath.length === 0) return false;
  if (typeof expectedRequirement !== "string" || expectedRequirement.length === 0) return false;
  try {
    const requirement = await readDesignatedRequirement(probePath, runTool);
    if (requirement !== expectedRequirement) return false;
    if (!requirement.includes(`identifier "${PEER_PROBE_IDENTIFIER}"`)) return false;
    const detailed = await runTool("/usr/bin/codesign", ["-dv", probePath], { timeout: 5_000 });
    // codesign writes its display output to stderr as often as stdout (build-dev-helper.mjs
    // records the same), so the signature line is read from BOTH streams.
    const signatureLine = `${normalizeToolOutput(detailed)}${normalizeToolOutput(detailed?.stderr)}`;
    if (signatureLine.includes("Signature=adhoc")) return false;
    await runTool("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--all-architectures",
      `-R=${expectedRequirement}`,
      probePath,
    ]);
    return true;
  } catch {
    return false;
  }
}
