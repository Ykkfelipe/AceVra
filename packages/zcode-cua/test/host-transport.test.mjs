// CUA-1.5 host-owned transport tests (deterministic, in-process).
//
// Run with: node --test packages/zcode-cua/test/host-transport.test.mjs
//
// The hardened transport's security claims are testable without the Swift helper: the host
// relay's admission policy, capability gating, session ownership and fail-closed behaviour are
// all exercised with a *fake helper* — a plain Node socket that speaks the hello/request wire
// format. The real-helper end of the contract (host requirement verification via SecCode,
// sealed-bundle validation) is measured by native/cua-helper/run-bundle-validity-probe.sh and
// the live verification script, per the spec; those need macOS code-signing tooling and are
// not asserted here.

import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { evaluateHelperIdentity } from "../broker.js";
import {
  buildHostConnectOpenArgs,
  collectValidatedHelperPids,
  createCuaBrokerHost,
  evaluateHelperHello,
  readDesignatedRequirement,
  tokensMatch,
} from "../host-transport.js";

const HELPER_ID = "dev.zcode.cua-helper.dev";

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

/**
 * A fake helper: connects to the host session, presents a hello, and answers requests from the
 * relay until disconnected. Records every forwarded request so tests can assert what the real
 * helper would (and would not) have received.
 */
function fakeHelper(
  host,
  {
    pid = process.pid,
    identifier = HELPER_ID,
    token = host.token,
    verified = true,
    adHoc = false,
  } = {},
) {
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
              helper_identity: verifiedIdentity(identifier),
            },
            id: message.id,
          })}\n`,
        );
        for (const waiter of waiters.splice(0)) waiter();
      }
    }
  });
  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({
        ok: true,
        result: {
          type: "helper_hello",
          transport: "host-connect",
          launch_token: token,
          helper_identity: { ...verifiedIdentity(identifier), verified, ad_hoc: adHoc },
          pid,
        },
      })}\n`,
    );
  });
  return {
    socket,
    received,
    waitForRequest() {
      if (received.length > 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

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

describe("CUA-1.5 helper hello admission policy", () => {
  const basePolicy = (overrides = {}) => ({
    launchToken: "tok-abc",
    expectedHelperIdentifiers: [HELPER_ID],
    validatedPids: new Set([4242]),
    ...overrides,
  });
  const hello = (overrides = {}) => ({
    result: {
      type: "helper_hello",
      transport: "host-connect",
      launch_token: "tok-abc",
      helper_identity: verifiedIdentity(),
      pid: 4242,
      ...overrides,
    },
  });

  it("admits a valid helper hello", () => {
    const verdict = evaluateHelperHello(hello(), basePolicy());
    assert.equal(verdict.admitted, true);
    assert.equal(verdict.pid, 4242);
    assert.equal(verdict.identifier, HELPER_ID);
  });

  it("rejects a wrong signer (identifier outside the expected set)", () => {
    const verdict = evaluateHelperHello(
      hello({ helper_identity: verifiedIdentity("com.evil.helper") }),
      basePolicy(),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_mismatch");
  });

  it("rejects a wrong bundle identity even when it claims verified", () => {
    const verdict = evaluateHelperHello(
      hello({ helper_identity: { ...verifiedIdentity(), identifier: "dev.zcode.cua-helper" } }),
      basePolicy(),
    );
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_mismatch");
  });

  it("rejects a tampered helper (self-check failed) and an ad-hoc one", () => {
    const tampered = evaluateHelperHello(
      hello({ helper_identity: { ...verifiedIdentity(), verified: false, reason: "seal broken" } }),
      basePolicy(),
    );
    assert.equal(tampered.admitted, false);
    assert.equal(tampered.code, "helper_identity_unverified");
    const adhoc = evaluateHelperHello(
      hello({ helper_identity: { ...verifiedIdentity(), ad_hoc: true } }),
      basePolicy(),
    );
    assert.equal(adhoc.admitted, false);
    assert.equal(adhoc.code, "helper_identity_adhoc");
  });

  it("rejects a wrong or missing launch token", () => {
    assert.equal(
      evaluateHelperHello(hello({ launch_token: "nope" }), basePolicy()).code,
      "wrong_helper_token",
    );
    assert.equal(
      evaluateHelperHello(hello({ launch_token: undefined }), basePolicy()).code,
      "wrong_helper_token",
    );
  });

  it("rejects a hello whose pid the host did not itself validate", () => {
    const verdict = evaluateHelperHello(hello({ pid: 999 }), basePolicy());
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_process_unverified");
  });

  it("rejects a non-hello first line", () => {
    assert.equal(
      evaluateHelperHello({ id: "1", method: "list_apps" }, basePolicy()).code,
      "bad_hello",
    );
    assert.equal(evaluateHelperHello("garbage", basePolicy()).code, "bad_hello");
  });

  it("fails closed when no expected identities are configured", () => {
    const verdict = evaluateHelperHello(hello(), basePolicy({ expectedHelperIdentifiers: [] }));
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.code, "helper_identity_policy_missing");
  });

  it("admission verdicts agree with the client-side evaluateHelperIdentity verdicts", () => {
    // The admission block and broker.js must not drift; same inputs, same codes.
    const cases = [
      undefined,
      { verified: false },
      { ...verifiedIdentity(), ad_hoc: true },
      verifiedIdentity("other.signer"),
      verifiedIdentity(),
    ];
    for (const identity of cases) {
      const admission = evaluateHelperHello(hello({ helper_identity: identity }), basePolicy());
      const client = evaluateHelperIdentity(identity, [HELPER_ID]);
      const admissionCode = admission.admitted ? "ok" : admission.code;
      assert.equal(admissionCode, client.code, `identity: ${JSON.stringify(identity)}`);
    }
  });
});

describe("CUA-1.5 capability token comparison", () => {
  it("matches equal tokens and rejects everything else without throwing", () => {
    assert.equal(tokensMatch("abc", "abc"), true);
    assert.equal(tokensMatch("abc", "abd"), false);
    assert.equal(tokensMatch("abc", "abcdefgh"), false); // unequal lengths must not throw
    assert.equal(tokensMatch(undefined, "abc"), false);
    assert.equal(tokensMatch("abc", ""), false);
  });
});

describe("CUA-1.5 launch args and requirement discovery", () => {
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

describe("CUA-1.5 host-derived helper pid validation", () => {
  const psListing = [
    "  101 /usr/sbin/syslogd",
    "  4242 /root/computer-use/dev/Helper.app/Contents/MacOS/Helper",
    "  4243 /elsewhere/Helper.app/Contents/MacOS/Helper",
    "  not-a-pid line",
  ].join("\n");

  it("validates only processes under the install roots, against the requirement", async () => {
    const codesignCalls = [];
    const pids = await collectValidatedHelperPids({
      installRoots: ["/root/computer-use"],
      requirement: 'identifier "x"',
      runTool: async (file, args) => {
        if (file === "/bin/ps") return psListing;
        codesignCalls.push(args);
        return "";
      },
    });
    assert.deepEqual([...pids], [4242]);
    assert.equal(codesignCalls.length, 1);
    assert.deepEqual(codesignCalls[0].slice(0, 3), ["--verify", "--strict", "--all-architectures"]);
    assert.match(codesignCalls[0][3], /^-R=/, "requirement must be attached to -R");
  });

  it("excludes a candidate whose codesign validation fails (broken seal / wrong signer)", async () => {
    const pids = await collectValidatedHelperPids({
      installRoots: ["/root/computer-use"],
      requirement: 'identifier "x"',
      runTool: async (file) => {
        if (file === "/bin/ps") return psListing;
        throw new Error("invalid signature");
      },
    });
    assert.equal(pids.size, 0);
  });
});

describe("CUA-1.5 transport session (in-process relay)", () => {
  const dataRoot = shortTempRoot();
  let host;

  before(async () => {
    host = createCuaBrokerHost({
      dataRoot,
      expectedHelperIdentifiers: [HELPER_ID],
      collectValidatedPids: async () => new Set([process.pid]),
    });
    await host.start();
  });

  after(async () => {
    await host.stop();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("creates least-privilege endpoints (socket 0600 inside a 0700 session dir)", () => {
    assert.equal(statSync(host.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(host.sessionDir).mode & 0o777, 0o700);
  });

  it("uses a fresh randomized session identity (stale files cannot redirect)", async () => {
    const first = host.socketPath;
    const secondHost = createCuaBrokerHost({
      dataRoot,
      expectedHelperIdentifiers: [HELPER_ID],
      collectValidatedPids: async () => new Set([process.pid]),
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
    const refusal = await new Promise((resolve, reject) => {
      const socket = connect(host.socketPath);
      let buffer = "";
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index >= 0) {
          socket.destroy();
          resolve(JSON.parse(buffer.slice(0, index)));
        }
      });
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({
            ok: true,
            result: {
              type: "helper_hello",
              launch_token: host.token,
              helper_identity: verifiedIdentity(),
              pid: process.pid,
            },
          })}\n`,
        );
      });
      setTimeout(() => resolve(null), 1500);
    });
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(refusal, null, "a second helper is silently disconnected");
  });

  it("fails pending client traffic closed when the helper misbehaves or vanishes", async () => {
    const rogue = connect(host.socketPath);
    // admitted with a valid hello, then answers with a line that is not a broker response
    rogue.on("connect", () => {
      rogue.write(
        `${JSON.stringify({
          ok: true,
          result: {
            type: "helper_hello",
            launch_token: host.token,
            helper_identity: verifiedIdentity(),
            pid: process.pid,
          },
        })}\n`,
      );
    });
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
});

describe("CUA-1.5 stale session pruning", () => {
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
      collectValidatedPids: async () => new Set(),
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

describe("CUA-1.5 pre-bind/substitution boundaries (deterministic parts)", () => {
  it("a bound session socket cannot be stolen by a second bind (EADDRINUSE)", async () => {
    const dataRoot = shortTempRoot();
    const host = createCuaBrokerHost({
      dataRoot,
      expectedHelperIdentifiers: [HELPER_ID],
      collectValidatedPids: async () => new Set(),
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
      collectValidatedPids: async () => new Set([process.pid]),
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
