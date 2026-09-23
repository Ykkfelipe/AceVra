// CUA-1.75 host-owned transport tests (deterministic, in-process).
//
// Run with: node --test packages/zcode-cua/test/host-transport.test.mjs
//
// The hardened transport's security claims are testable without the Swift helper: the host
// relay's admission policy (native peer binding evaluation, launch-contract equality, token
// gating, session ownership, fail-closed behaviour) is exercised with a *fake helper* — a
// plain Node socket that speaks the hello/request wire format — and an injected
// `bindPeerIdentity` standing in for the native probe. The probe's own end (audit-token
// binding, SecCode verification of the exact process instance, KERN_PROCARGS2) is measured
// live by native/peer-identity/run-cua175-verification.mjs, per the spec; those need macOS
// code-signing tooling and are not asserted here.

import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { evaluateHelperIdentity } from "../broker.js";
import {
  buildHostConnectOpenArgs,
  createCuaBrokerHost,
  evaluateHelperHello,
  HELLO_TYPE,
  hostConnectHelperArgv,
  helperArgvMatches,
  PEER_PROBE_IDENTIFIER,
  readDesignatedRequirement,
  tokensMatch,
  verifyPeerProbe,
} from "../host-transport.js";

const HELPER_ID = "dev.acevra.cua-helper.development";
const HOST_REQUIREMENT = 'identifier "test.host" and certificate root = H"host"';
const HELPER_REQUIREMENT = 'identifier "test.helper" and certificate root = H"helper"';
const OBSERVATION_DIR = "/x/observations";

const verifiedIdentity = (identifier = HELPER_ID) => ({
  verified: true,
  identifier,
  team_id: "",
  cd_hash: "a".repeat(64),
  requirement: `identifier "${identifier}"`,
  ad_hoc: false,
  pid: 4242,
  expected_identifier: identifier,
  expectation_source: "configured",
  bundle_validated: true,
  reason: "",
});

/** Short root: macOS sun_path caps at 104 bytes and the default tmpdir is deep. */
function shortTempRoot() {
  return mkdtempSync(join("/tmp", "cua-ht-test-"));
}

/** A complete kernel binding report the way the native probe produces it. */
const peerBinding = (overrides = {}) => ({
  pid: 4242,
  pidversion: 7,
  binding: { pid: overrides.pid ?? 4242, pidversion: 7, peerpid_agrees: true },
  identity: { ...verifiedIdentity(), pid: overrides.pid ?? 4242 },
  peerArgs: [
    "/opt/helper.app/Contents/MacOS/Helper",
    "--connect",
    "/x/s-1/b.sock",
    "--launch-token",
    "tok-abc",
    "--require-host-requirement",
    HOST_REQUIREMENT,
    "--expected-requirement",
    HELPER_REQUIREMENT,
    "--observation-dir",
    OBSERVATION_DIR,
    "--idle-ms",
    "15000",
  ],
  ...overrides,
});

/** The base hello policy: same launch contract the binding report above exec'd with. */
const basePolicy = (overrides = {}) => ({
  launchToken: "tok-abc",
  expectedHelperIdentifiers: [HELPER_ID],
  expectedHelperArgv: peerBinding().peerArgs.slice(1),
  ...overrides,
});

const hello = (overrides = {}) => ({
  result: {
    type: HELLO_TYPE,
    transport: "host-connect",
    launch_token: "tok-abc",
    helper_identity: verifiedIdentity(),
    pid: 4242,
    ...overrides,
  },
});

describe("CUA-1.75 helper hello admission policy", () => {
  it("admits a valid helper hello backed by a complete kernel binding", () => {
    const verdict = evaluateHelperHello(hello(), basePolicy(), peerBinding());
    assert.equal(verdict.admitted, true);
    assert.equal(verdict.pid, 4242);
    assert.equal(verdict.identifier, HELPER_ID);
  });

  it("rejects a wrong signer (identifier outside the expected set)", () => {
    const verdict = evaluateHelperHello(
      hello({ helper_identity: verifiedIdentity("com.evil.helper") }),
      basePolicy(),
      peerBinding({ identity: verifiedIdentity("com.evil.helper") }),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_mismatch");
  });

  it("rejects an unverified peer (tampered or re-signed helper)", () => {
    const verdict = evaluateHelperHello(
      hello({ helper_identity: verifiedIdentity("com.evil.helper") }),
      basePolicy(),
      peerBinding({
        identity: {
          ...verifiedIdentity("com.evil.helper"),
          verified: false,
          reason: "seal broken",
        },
      }),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_unverified");
  });

  it("rejects an ad-hoc peer signature", () => {
    const verdict = evaluateHelperHello(
      hello({ helper_identity: verifiedIdentity("com.evil.helper") }),
      basePolicy(),
      peerBinding({ identity: { ...verifiedIdentity("com.evil.helper"), ad_hoc: true } }),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_adhoc");
  });

  it("rejects a wrong or missing launch token", () => {
    assert.equal(
      evaluateHelperHello(hello({ launch_token: "nope" }), basePolicy(), peerBinding()).code,
      "wrong_helper_token",
    );
    assert.equal(
      evaluateHelperHello(hello({ launch_token: undefined }), basePolicy(), peerBinding()).code,
      "wrong_helper_token",
    );
  });

  it("rejects a connection the kernel could not bind (no native probe report)", () => {
    for (const binding of [null, undefined, {}, { pid: 0 }, { pid: 4242, peerArgs: [] }]) {
      const verdict = evaluateHelperHello(hello(), basePolicy(), binding);
      assert.equal(verdict.admitted, false, JSON.stringify(binding));
      assert.equal(verdict.code, "peer_identity_unavailable", JSON.stringify(binding));
    }
  });

  it("never lets a quoted pid authorize: hello pid must equal the kernel-bound pid", () => {
    // The binding names pid 4242; quoting a stale, recycled or borrowed pid in the hello
    // cannot move the decision (spec "Admission rules", check 5).
    for (const quoted of [999, 0, -1, undefined, "4242"]) {
      const verdict = evaluateHelperHello(hello({ pid: quoted }), basePolicy(), peerBinding());
      assert.equal(verdict.admitted, false, String(quoted));
      assert.equal(verdict.code, "helper_process_unverified", String(quoted));
    }
  });

  it("refuses a hello whose identity envelope contradicts the verified signature", () => {
    const verdict = evaluateHelperHello(
      hello({ helper_identity: verifiedIdentity("com.evil.helper") }),
      basePolicy(),
      peerBinding(),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_mismatch");
  });

  it("refuses a hello whose cdhash claim contradicts the verified signature", () => {
    const verdict = evaluateHelperHello(
      hello({ helper_identity: { ...verifiedIdentity(), cd_hash: "b".repeat(64) } }),
      basePolicy(),
      peerBinding(),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_mismatch");
  });

  it("rejects a non-hello first line", () => {
    assert.equal(
      evaluateHelperHello({ id: "1", method: "list_apps" }, basePolicy(), peerBinding()).code,
      "bad_hello",
    );
    assert.equal(evaluateHelperHello("garbage", basePolicy(), peerBinding()).code, "bad_hello");
  });

  it("fails closed when no expected identities are configured", () => {
    const verdict = evaluateHelperHello(
      hello(),
      basePolicy({ expectedHelperIdentifiers: [] }),
      peerBinding(),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_policy_missing");
  });

  it("fails closed when the launch contract could not be built", () => {
    const verdict = evaluateHelperHello(
      hello(),
      basePolicy({ expectedHelperArgv: null }),
      peerBinding(),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_launch_contract_mismatch");
  });

  it("admission identity verdicts agree with the client-side evaluateHelperIdentity", () => {
    // The admission block and broker.js must not drift; same inputs, same codes. The client
    // sees the identity envelope the helper reports; the host applies the same rules to the
    // binding's host-derived identity.
    const cases = [
      undefined,
      { verified: false },
      { ...verifiedIdentity(), ad_hoc: true },
      verifiedIdentity("other.signer"),
      verifiedIdentity(),
    ];
    for (const identity of cases) {
      const admission = evaluateHelperHello(
        { result: { type: HELLO_TYPE, launch_token: "tok-abc", pid: 4242 } },
        basePolicy(),
        peerBinding({ identity }),
      );
      const client = evaluateHelperIdentity(identity, [HELPER_ID]);
      const admissionCode = admission.admitted ? "ok" : admission.code;
      assert.equal(admissionCode, client.code, `identity: ${JSON.stringify(identity)}`);
    }
  });
});

describe("CUA-1.75 launch-contract equality", () => {
  it("matches the minted contract exactly", () => {
    assert.equal(helperArgvMatches(peerBinding().peerArgs, basePolicy().expectedHelperArgv), true);
  });

  it("the builder's --args tail is the contract the admission side checks (no drift)", () => {
    const spec = {
      appPath: "/opt/helper.app",
      socketPath: "/x/s-1/b.sock",
      launchToken: "tok-abc",
      hostRequirement: HOST_REQUIREMENT,
      helperRequirement: HELPER_REQUIREMENT,
      observationDir: OBSERVATION_DIR,
      idleMs: 15_000,
    };
    assert.deepEqual(buildHostConnectOpenArgs(spec).slice(3), hostConnectHelperArgv(spec));
  });

  it("refuses a genuine-looking peer launched with a different --require-host-requirement", () => {
    // Even a requirement the host would also satisfy is a contract violation (spec: textual
    // equality with the pinned contract, not "would match").
    const relaxed = peerBinding({
      peerArgs: peerBinding().peerArgs.map((value) =>
        value === HOST_REQUIREMENT ? `(${HOST_REQUIREMENT})` : value,
      ),
    });
    const verdict = evaluateHelperHello(hello(), basePolicy(), relaxed);
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_launch_contract_mismatch");
  });

  it("refuses a peer whose exec args carry any other contract difference", () => {
    const mismatches = {
      "different socket": peerBinding().peerArgs.map((v) =>
        v === "/x/s-1/b.sock" ? "/x/evil.sock" : v,
      ),
      "different observation dir": peerBinding().peerArgs.map((v) =>
        v === OBSERVATION_DIR ? "/x/evil-obs" : v,
      ),
      "missing flag": peerBinding().peerArgs.filter((v) => v !== "15000" && v !== "--idle-ms"),
      "extra flag": [...peerBinding().peerArgs, "--serve"],
      "duplicated flag": [...peerBinding().peerArgs, "--idle-ms", "1"],
      "swapped requirement": peerBinding().peerArgs.map((v) =>
        v === HELPER_REQUIREMENT ? HOST_REQUIREMENT : v,
      ),
    };
    for (const [name, argv] of Object.entries(mismatches)) {
      const verdict = evaluateHelperHello(hello(), basePolicy(), peerBinding({ peerArgs: argv }));
      assert.equal(verdict.admitted, false, name);
      assert.equal(verdict.code, "helper_launch_contract_mismatch", name);
    }
  });

  it("argv[0] is not part of the contract (exec path is free, flags are not)", () => {
    const elsewhere = peerBinding({
      peerArgs: ["/attacker/path/Helper", ...peerBinding().peerArgs.slice(1)],
    });
    assert.equal(helperArgvMatches(elsewhere.peerArgs, basePolicy().expectedHelperArgv), true);
  });

  it("helperArgvMatches rejects malformed shapes without throwing", () => {
    const expected = basePolicy().expectedHelperArgv;
    assert.equal(helperArgvMatches([], expected), false);
    assert.equal(helperArgvMatches(["/x"], expected), false);
    assert.equal(helperArgvMatches(undefined, expected), false);
    assert.equal(helperArgvMatches(["/x", "--connect"], expected), false, "dangling value");
  });
});

describe("CUA-1.75 capability token comparison", () => {
  it("matches equal tokens and rejects everything else without throwing", () => {
    assert.equal(tokensMatch("abc", "abc"), true);
    assert.equal(tokensMatch("abc", "abd"), false);
    assert.equal(tokensMatch("abc", "abcdefgh"), false); // unequal lengths must not throw
    assert.equal(tokensMatch(undefined, "abc"), false);
    assert.equal(tokensMatch("abc", ""), false);
  });
});

describe("CUA-1.75 launch args and requirement discovery", () => {
  it("builds the complete /usr/bin/open argv for a host-connect launch", () => {
    const args = buildHostConnectOpenArgs({
      appPath: "/opt/helper.app",
      socketPath: "/x/s-1/b.sock",
      launchToken: "tok",
      hostRequirement: 'identifier "host"',
      helperRequirement: 'identifier "helper"',
      observationDir: "/x/observations",
      idleMs: 15_000,
    });
    assert.deepEqual(args.slice(0, 3), ["-a", "/opt/helper.app", "--args"]);
    assert.ok(args.includes("--connect") && args.includes("/x/s-1/b.sock"));
    assert.ok(args.includes("--launch-token") && args.includes("tok"));
    assert.ok(args.includes("--require-host-requirement") && args.includes('identifier "host"'));
    assert.ok(args.includes("--expected-requirement") && args.includes('identifier "helper"'));
    assert.ok(args.includes("--observation-dir") && args.includes("/x/observations"));
    assert.ok(args.includes("--idle-ms") && args.includes("15000"));
  });

  it("refuses to build args with a missing field (observation dir is mandatory)", () => {
    assert.throws(() =>
      buildHostConnectOpenArgs({
        appPath: "/opt/helper.app",
        socketPath: "/x/b.sock",
        launchToken: "tok",
        hostRequirement: "r",
        helperRequirement: "r",
      }),
    );
    assert.throws(() => hostConnectHelperArgv({ launchToken: "tok" }));
  });

  it("reads a designated requirement from codesign output and fails closed on unsigned code", async () => {
    const requirement = await readDesignatedRequirement("/any/app", async () => ({
      stdout: 'Executable=/any/app\n_designated => identifier "x" and certificate root = H"abc"\n',
      stderr: "",
    }));
    assert.equal(requirement, 'identifier "x" and certificate root = H"abc"');
    const unsigned = await readDesignatedRequirement("/any/app", async () => {
      throw new Error("code object is not signed");
    });
    assert.equal(unsigned, null);
  });
});

describe("CUA-1.75 peer-identity probe gate", () => {
  const probePath = "/opt/dev/peer-identity-probe";
  const probeRequirement = `identifier "${PEER_PROBE_IDENTIFIER}" and certificate root = H"abc"`;

  /** codesign double for the gate: -d -r- → DR, -dv → signature line, --verify → seal. */
  const probeRunTool =
    ({ requirement = probeRequirement, adhoc = false, sealBroken = false } = {}) =>
    async (file, args) => {
      if (args[0] === "-d" && args[1] === "-r-") {
        return { stdout: `Executable=${probePath}\ndesignated => ${requirement}\n` };
      }
      if (args[0] === "-dv") {
        return { stdout: `Executable=${probePath}\nSignature=${adhoc ? "adhoc" : "stable"}\n` };
      }
      if (sealBroken) throw new Error("invalid signature");
      return "";
    };

  it("accepts a sealed, non-ad-hoc probe matching the session-pinned requirement", async () => {
    const calls = [];
    const runner = probeRunTool();
    const ok = await verifyPeerProbe(probePath, probeRequirement, async (file, args) => {
      calls.push(args);
      return runner(file, args);
    });
    assert.equal(ok, true);
    const verifyCall = calls.find((args) => args[0] === "--verify");
    assert.ok(verifyCall, "the probe seal must be validated against the pinned requirement");
    assert.equal(verifyCall[3], `-R=${probeRequirement}`);
  });

  it("refuses a probe whose on-disk requirement differs from the pinned one (swapped binary)", async () => {
    const swapped = await verifyPeerProbe(
      probePath,
      probeRequirement,
      probeRunTool({
        requirement: `identifier "${PEER_PROBE_IDENTIFIER}" and certificate root = H"evil"`,
      }),
    );
    assert.equal(swapped, false);
  });

  it("refuses a probe binary whose requirement names a different identifier", async () => {
    const impostor = await verifyPeerProbe(
      probePath,
      probeRequirement,
      probeRunTool({ requirement: 'identifier "com.evil.probe" and certificate root = H"abc"' }),
    );
    assert.equal(impostor, false);
  });

  it("refuses an ad-hoc signed probe (a self-signed impostor is not trusted code)", async () => {
    const adhoc = await verifyPeerProbe(probePath, probeRequirement, probeRunTool({ adhoc: true }));
    assert.equal(adhoc, false);
  });

  it("refuses an unsigned or unverifiable probe binary", async () => {
    const unsigned = await verifyPeerProbe(probePath, probeRequirement, async () => {
      throw new Error("code object is not signed");
    });
    assert.equal(unsigned, false);
    const brokenSeal = await verifyPeerProbe(
      probePath,
      probeRequirement,
      probeRunTool({ sealBroken: true }),
    );
    assert.equal(brokenSeal, false);
    const missingRequirement = await verifyPeerProbe(probePath, "", probeRunTool());
    assert.equal(missingRequirement, false);
  });
});

describe("CUA-1.75 transport session (in-process relay)", () => {
  const dataRoot = shortTempRoot();
  let host;
  let contractArgv;
  /** Per-test override for what the injected binder reports (null = no binding at all). */
  let nextBinding;

  const baseBinding = () =>
    peerBinding({
      pid: process.pid,
      identity: { ...verifiedIdentity(), pid: process.pid },
      peerArgs: ["/opt/helper.app/Contents/MacOS/Helper", ...contractArgv],
    });

  before(async () => {
    host = createCuaBrokerHost({
      dataRoot,
      expectedHelperIdentifiers: [HELPER_ID],
      launchContract: {
        hostRequirement: HOST_REQUIREMENT,
        helperRequirement: HELPER_REQUIREMENT,
        observationDir: OBSERVATION_DIR,
        idleMs: 15_000,
      },
      bindPeerIdentity: async () => {
        if (nextBinding === null) return null;
        return nextBinding === undefined ? baseBinding() : { ...baseBinding(), ...nextBinding };
      },
    });
    await host.start();
    contractArgv = hostConnectHelperArgv({
      socketPath: host.socketPath,
      launchToken: host.token,
      hostRequirement: HOST_REQUIREMENT,
      helperRequirement: HELPER_REQUIREMENT,
      observationDir: OBSERVATION_DIR,
      idleMs: 15_000,
    });
    nextBinding = undefined;
  });

  after(async () => {
    await host.stop();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  /** Connect a raw socket, write `line`, resolve with the host's first response object. */
  function helloResponse(line) {
    return new Promise((resolve, reject) => {
      const socket = connect(host.socketPath);
      let buffer = "";
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        socket.destroy();
        try {
          resolve(JSON.parse(buffer.slice(0, index)));
        } catch (error) {
          reject(error);
        }
      });
      socket.on("connect", () => socket.write(line));
    });
  }

  const helloLine = (overrides = {}) =>
    `${JSON.stringify({
      ok: true,
      result: {
        type: HELLO_TYPE,
        transport: "host-connect",
        launch_token: host.token,
        helper_identity: verifiedIdentity(),
        pid: process.pid,
        ...overrides,
      },
    })}\n`;

  it("creates least-privilege endpoints (socket 0600 inside a 0700 session dir)", () => {
    assert.equal(statSync(host.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(host.sessionDir).mode & 0o777, 0o700);
  });

  it("uses a fresh randomized session identity (stale files cannot redirect)", async () => {
    const first = host.socketPath;
    const secondHost = createCuaBrokerHost({
      dataRoot,
      expectedHelperIdentifiers: [HELPER_ID],
      launchContract: {
        hostRequirement: HOST_REQUIREMENT,
        helperRequirement: HELPER_REQUIREMENT,
        observationDir: OBSERVATION_DIR,
      },
      bindPeerIdentity: async () => null,
    });
    await secondHost.start();
    try {
      assert.notEqual(secondHost.socketPath, first);
      assert.equal(existsSync(first), true, "the live session stays untouched");
    } finally {
      await secondHost.stop();
    }
    assert.equal(existsSync(secondHost.socketPath), false, "stop removes the session socket");
  });

  it("admits a valid helper and relays its answers, stripping the token", async () => {
    const helper = fakeHelper(host);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(host.helperConnected, true);
    assert.equal(host.admittedHelper?.pid, process.pid);
    assert.equal(host.admittedHelper?.identifier, HELPER_ID);
    const response = await clientCall(host, { token: host.token });
    await helper.waitForRequest();
    assert.equal(response.ok, true);
    assert.equal(helper.received[0].method, "list_apps");
    assert.equal("token" in helper.received[0], false, "token must never reach the helper");
    // leave the session free for the following tests
    helper.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(host.helperConnected, false);
  });

  it("refuses an admission the kernel could not bind (fake same-uid claimant)", async () => {
    // An unverified process that knows the token and speaks the hello wire format: the native
    // binding comes back empty (its peer identity is not the helper), and the connection is
    // refused with the stable code — token possession alone opens nothing.
    nextBinding = null;
    try {
      const response = await helloResponse(helloLine());
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "peer_identity_unavailable");
      assert.equal(host.helperConnected, false);
    } finally {
      nextBinding = undefined;
    }
  });

  it("refuses a peer whose bound identity fails the pinned requirement (wrong signer)", async () => {
    nextBinding = {
      identity: { ...verifiedIdentity("com.evil.helper"), pid: process.pid, verified: false },
    };
    try {
      const response = await helloResponse(helloLine());
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "helper_identity_unverified");
      assert.equal(host.helperConnected, false);
    } finally {
      nextBinding = undefined;
    }
  });

  it("refuses a claimant quoting a pid other than its kernel-bound one (stale pid)", async () => {
    nextBinding = {
      identity: { ...verifiedIdentity(), pid: 987_654 },
      pid: 987_654,
    };
    try {
      // hello still quotes process.pid; the binding names 987_654 — consistency refuses.
      const response = await helloResponse(helloLine());
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "helper_process_unverified");
      assert.equal(host.helperConnected, false);
    } finally {
      nextBinding = undefined;
    }
  });

  it("refuses a peer exec'd with a different launch contract (attacker-launched helper)", async () => {
    nextBinding = {
      peerArgs: [
        "/opt/helper.app/Contents/MacOS/Helper",
        ...hostConnectHelperArgv({
          socketPath: host.socketPath,
          launchToken: host.token,
          hostRequirement: 'identifier "attacker.host"', // different trust anchor
          helperRequirement: HELPER_REQUIREMENT,
          observationDir: OBSERVATION_DIR,
        }),
      ],
    };
    try {
      const response = await helloResponse(helloLine());
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "helper_launch_contract_mismatch");
      assert.equal(host.helperConnected, false);
    } finally {
      nextBinding = undefined;
    }
  });

  it("refuses client requests with a missing session capability", async () => {
    const response = await clientCall(host, { token: undefined });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "missing_session_capability");
  });

  it("refuses client requests with a wrong caller token", async () => {
    const response = await clientCall(host, { token: "wrong-token" });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "wrong_caller");
  });

  it("keeps unregistered and mutating method names off the helper connection", async () => {
    for (const method of ["left_click", "type", "__proto__", "observe; drop", ""]) {
      const response = await clientCall(host, { token: host.token, method });
      assert.equal(response.ok, false, method);
      assert.equal(response.error.code, "not_authorized", method);
    }
  });

  it("answers malformed lines with bad_request and keeps the connection usable", async () => {
    const helper = fakeHelper(host);
    await new Promise((resolve) => setTimeout(resolve, 120));
    try {
      const response = await clientCall(host, { token: host.token, raw: "not-json\n" });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "bad_request");
      // same connection semantics as the helper: a second, valid request still works
      const second = await clientCall(host, { token: host.token });
      assert.equal(second.ok, true);
    } finally {
      helper.socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  });

  it("destroys a client line that never terminates within the size cap", async () => {
    const verdict = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const socket = connect(host.socketPath);
      // EPIPE after the relay destroys us is the expected shape of this test, not a failure.
      socket.on("error", () => finish("closed"));
      socket.on("close", () => finish("closed"));
      socket.on("connect", () => {
        socket.write(`{"id":"1","method":"list_apps","token":"${host.token}","pad":"`);
        let sent = 0;
        const timer = setInterval(() => {
          if (!socket.writable) {
            clearInterval(timer);
            return;
          }
          socket.write("x".repeat(256 * 1024));
          sent += 256 * 1024;
          if (sent > 2 * 1024 * 1024) clearInterval(timer);
        }, 10);
      });
      setTimeout(() => finish("still-open"), 3000);
    });
    assert.equal(verdict, "closed");
  });

  it("admits a new helper after the previous one disconnects (restart/reconnect)", async () => {
    const first = fakeHelper(host);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(host.helperConnected, true);
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(host.helperConnected, false);
    const second = fakeHelper(host);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(host.helperConnected, true);
    assert.equal(host.admittedHelper?.pid, process.pid);
    const response = await clientCall(host, { token: host.token });
    await second.waitForRequest();
    assert.equal(response.ok, true);
    second.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  it("refuses a second helper while one is admitted (single session)", async () => {
    const first = fakeHelper(host);
    await new Promise((resolve) => setTimeout(resolve, 120));
    // A second hello while one is admitted is silently disconnected (no response line).
    const refusal = await new Promise((resolve) => {
      const socket = connect(host.socketPath);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index >= 0) {
          socket.destroy();
          resolve(JSON.parse(buffer.slice(0, index)));
        }
      });
      socket.on("connect", () => socket.write(helloLine()));
      setTimeout(() => resolve(null), 1500);
    });
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(refusal, null, "a second helper is silently disconnected");
  });

  it("fails pending client traffic closed when the helper misbehaves or vanishes", async () => {
    const rogue = connect(host.socketPath);
    // admitted with a valid hello, then answers with a line that is not a broker response
    rogue.on("connect", () => rogue.write(helloLine()));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(host.helperConnected, true);
    const pendingCall = clientCall(host, { token: host.token, id: "9" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    rogue.write("this is not json\n");
    // The relay fails the pending request closed (an error response, never a hang) and drops
    // the misbehaving helper connection.
    const response = await pendingCall;
    assert.equal(response.ok, false);
    assert.ok(
      ["helper_disconnected", "bad_response", "connect_failed"].includes(response.error?.code),
      `unexpected error code: ${response.error?.code}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(host.helperConnected, false);
    rogue.destroy();
  });

  it("never leaks host filesystem paths in client-visible error text", async () => {
    const probes = [
      clientCall(host, { token: undefined }),
      clientCall(host, { token: "nope" }),
      clientCall(host, { token: host.token, method: "kill_app" }),
      clientCall(host, { token: host.token, raw: "%%%\n" }),
    ];
    const responses = await Promise.all(probes);
    for (const response of responses) {
      const text = JSON.stringify(response);
      assert.equal(text.includes(dataRoot), false, text);
      assert.equal(text.includes("/tmp"), false, text);
      assert.equal(text.includes(host.socketPath), false, text);
    }
  });

  it("in-process callMethod rides the same relay pipeline", async () => {
    const helper = fakeHelper(host);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const result = await host.callMethod("permission_status");
    await helper.waitForRequest();
    assert.equal(result.echo, "permission_status");
  });

  /** Declared late so the transport tests above read first; shared by all fake helpers. */
  function fakeHelper(host, overrides = {}) {
    const received = [];
    const socket = connect(host.socketPath);
    let buffer = "";
    const waiters = [];
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line);
        if (message?.id) {
          received.push(message);
          socket.write(
            `${JSON.stringify({
              ok: true,
              result: {
                echo: message.method,
                ...message.params,
                helper_identity: verifiedIdentity(),
              },
              id: message.id,
            })}\n`,
          );
          for (const waiter of waiters.splice(0)) waiter();
        }
      }
    });
    socket.on("connect", () => socket.write(helloLine(overrides.hello)));
    return {
      socket,
      received,
      waitForRequest() {
        if (received.length > 0) return Promise.resolve();
        return new Promise((resolve) => waiters.push(resolve));
      },
    };
  }
});

describe("CUA-1.75 stale session pruning", () => {
  it("removes session directories whose recorded owner pid is dead", async () => {
    const dataRoot = shortTempRoot();
    const sessionsRoot = join(dataRoot, "computer-use", "sessions");
    mkdirSync(join(sessionsRoot, "s-deadpid"), { recursive: true });
    writeFileSync(
      join(sessionsRoot, "s-deadpid", "session.json"),
      JSON.stringify({ pid: 999_999_999 }),
    );
    mkdirSync(join(sessionsRoot, "s-nogood"), { recursive: true });
    // a live session from another host process: this process itself
    mkdirSync(join(sessionsRoot, "s-alivepid"), { recursive: true });
    writeFileSync(
      join(sessionsRoot, "s-alivepid", "session.json"),
      JSON.stringify({ pid: process.pid }),
    );

    const host = createCuaBrokerHost({
      dataRoot,
      expectedHelperIdentifiers: [HELPER_ID],
      bindPeerIdentity: async () => null,
    });
    await host.start();
    try {
      assert.equal(existsSync(join(sessionsRoot, "s-deadpid")), false);
      assert.equal(existsSync(join(sessionsRoot, "s-nogood")), false);
      assert.equal(existsSync(join(sessionsRoot, "s-alivepid")), true);
    } finally {
      await host.stop();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

describe("CUA-1.75 pre-bind/substitution boundaries (deterministic parts)", () => {
  it("a bound session socket cannot be stolen by a second bind (EADDRINUSE)", async () => {
    const dataRoot = shortTempRoot();
    const host = createCuaBrokerHost({
      dataRoot,
      expectedHelperIdentifiers: [HELPER_ID],
      bindPeerIdentity: async () => null,
    });
    await host.start();
    try {
      const thief = createServer();
      await new Promise((resolve) => {
        thief.once("error", (error) => resolve(error.code));
        thief.listen(host.socketPath, () => {
          thief.close(() => resolve("bound"));
        });
      }).then((outcome) => {
        assert.equal(
          outcome,
          "EADDRINUSE",
          "an attacker must not be able to bind a live session socket",
        );
      });
    } finally {
      await host.stop();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("an impostor connection that skips the hello is treated as an unauthorized client", async () => {
    const dataRoot = shortTempRoot();
    const host = createCuaBrokerHost({
      dataRoot,
      expectedHelperIdentifiers: [HELPER_ID],
      bindPeerIdentity: async () => null,
    });
    await host.start();
    try {
      const response = await clientCall(host, {
        token: undefined,
        raw: '{"id":"1","method":"observe"}\n',
      });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "missing_session_capability");
    } finally {
      await host.stop();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

/** One client request line through the relay; resolves with the relay's response object. */
function clientCall(host, { token, method = "list_apps", params, id = "1", raw }) {
  return new Promise((resolve, reject) => {
    const socket = connect(host.socketPath);
    let buffer = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, index)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("connect", () => {
      const line =
        raw ??
        `${JSON.stringify({
          id,
          method,
          ...(params !== undefined ? { params } : {}),
          ...(token !== undefined ? { token } : {}),
        })}\n`;
      socket.write(line);
    });
  });
}
