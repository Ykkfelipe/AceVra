// CUA-1 observe-only broker tests.
//
// Run with: node --test packages/zcode-cua/test/broker.test.mjs
//
// The transport tests use an in-process server that speaks the documented wire format through
// the module's own server-side helpers, so the client, the framing and the method registry are
// exercised together without needing the Swift helper or any macOS permission.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  BROKER_SOCKET_ENV,
  BROKER_UNAVAILABLE_ENV,
  callBrokerMethod,
  dispatchRequest,
  errorResponse,
  handleRequestLine,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  parseRequestLine,
  probeHelperHealth,
  resolveBrokerSocketPath,
  serializeResponse,
} from "../broker.js";
import { createComputerUseRuntime } from "../index.js";

/**
 * The identity block a real Helper attaches to every result (see CodeIdentity.swift). The
 * transport tests must carry it too: `callBrokerMethod` refuses a response without a verified
 * helper identity, which is the point of the check.
 */
const VERIFIED_IDENTITY = Object.freeze({
  verified: true,
  identifier: "dev.acevra.cua-helper.development",
  team_id: "",
  cd_hash: "d2da364aa8e974b717f4acd1e16948867c0d7931",
  requirement: 'identifier "dev.acevra.cua-helper.development"',
  ad_hoc: false,
  pid: 4242,
  expected_identifier: "",
  expectation_source: "signature",
  reason: "",
});

describe("method registry", () => {
  it("registers CUA observation and bounded semantic methods", () => {
    for (const method of ["permission_status", "list_apps", "list_windows", "observe"]) {
      assert.equal(isBrokerMethod(method), true, `${method} should be a broker method`);
      assert.equal(isReadOnlyBrokerMethod(method), true, `${method} should be read-only`);
    }
    for (const method of ["press", "set_value"]) {
      assert.equal(isBrokerMethod(method), true);
      assert.equal(isReadOnlyBrokerMethod(method), false);
    }
  });

  it("refuses every mutating name so it can never reach an actuator", () => {
    for (const method of [
      "left_click",
      "type",
      "key",
      "scroll",
      "drag",
      "kill_app",
      "unknown_actuator",
    ]) {
      assert.equal(isBrokerMethod(method), false, `${method} must not be a broker method`);
      assert.equal(isReadOnlyBrokerMethod(method), false);
    }
  });

  it("is not fooled by inherited object properties", () => {
    assert.equal(isBrokerMethod("toString"), false);
    assert.equal(isBrokerMethod("__proto__"), false);
  });
});

describe("request framing", () => {
  it("parses a valid request line", () => {
    assert.deepEqual(parseRequestLine('{"id":"a","method":"observe","params":{"pid":1}}'), {
      id: "a",
      method: "observe",
      params: { pid: 1 },
    });
  });

  it("treats a missing id as null and tolerates trailing whitespace", () => {
    assert.deepEqual(parseRequestLine('  {"method":"list_apps"}  '), {
      id: null,
      method: "list_apps",
      params: undefined,
    });
  });

  it("returns undefined rather than throwing for malformed input", () => {
    for (const line of ["", "   ", "not json", "[1,2,3]", "null", '"str"', '{"id":"x"}', "{}"]) {
      assert.equal(parseRequestLine(line), undefined, `should reject: ${line}`);
    }
  });

  it("serializes with a trailing newline", () => {
    assert.equal(serializeResponse({ ok: true, result: {} }), '{"ok":true,"result":{}}\n');
  });
});

describe("server-side dispatch", () => {
  const backend = {
    list_apps: async () => ({ route: "workspace", effect: "confirmed" }),
    observe: async (params) => ({ pid: params.pid, effect: "partial" }),
    list_windows: async () => {
      throw Object.assign(new Error("window server unavailable"), { code: "not_available" });
    },
  };

  it("answers a known method with the handler result", async () => {
    const response = await dispatchRequest(backend, { method: "list_apps" });
    assert.deepEqual(response, {
      ok: true,
      result: { route: "workspace", effect: "confirmed" },
    });
  });

  it("passes params through to the handler", async () => {
    const response = await dispatchRequest(backend, { method: "observe", params: { pid: 42 } });
    assert.deepEqual(response.result, { pid: 42, effect: "partial" });
  });

  it("refuses a mutating method with not_authorized and never calls a handler", async () => {
    const response = await dispatchRequest(backend, { method: "left_click" });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "not_authorized");
  });

  it("reports a missing handler without pretending success", async () => {
    const response = await dispatchRequest({}, { method: "permission_status" });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unsupported_method");
  });

  it("carries a thrown handler error's code into the failure envelope", async () => {
    const response = await dispatchRequest(backend, { method: "list_windows" });
    assert.equal(response.ok, false);
    assert.equal(response.error.message, "window server unavailable");
    assert.equal(response.error.code, "not_available");
  });

  it("rejects a request with no method", async () => {
    const response = await dispatchRequest(backend, {});
    assert.equal(response.error.code, "bad_request");
  });

  it("answers a malformed line instead of throwing", async () => {
    const response = await handleRequestLine(backend, "{{{");
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "bad_request");
  });

  it("uses the nested failure shape the contract already had", () => {
    assert.deepEqual(errorResponse("boom", { code: "x" }), {
      ok: false,
      error: { message: "boom", code: "x" },
    });
  });
});

describe("socket paths", () => {
  it("prefers an explicit environment socket path", () => {
    assert.equal(
      resolveBrokerSocketPath({ env: { [BROKER_SOCKET_ENV]: "/tmp/explicit.sock" } }),
      "/tmp/explicit.sock",
    );
  });

  it("falls back to a stable path under the runtime data root", () => {
    // Stability matters: callers use this to find a running Helper, which a random path could
    // never do.
    const first = resolveBrokerSocketPath({ env: { ZCODE_HOME: "/tmp/cua-test-home" } });
    const second = resolveBrokerSocketPath({ env: { ZCODE_HOME: "/tmp/cua-test-home" } });
    assert.equal(first, second);
    assert.equal(first, "/tmp/cua-test-home/computer-use/helper.sock");
  });
});

describe("client transport", () => {
  let dir;
  let socketPath;
  let server;
  let seen = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cua-broker-test-"));
    socketPath = join(dir, "helper.sock");
    const backend = {
      permission_status: async () => ({
        grant_owner: "dev.acevra.cua-helper.development",
        helper_identity: VERIFIED_IDENTITY,
        identity: { pid: 4242 },
        accessibility: "granted",
        screen_recording: "granted",
      }),
      list_apps: async () => ({
        count: 2,
        route: "workspace",
        effect: "confirmed",
        helper_identity: VERIFIED_IDENTITY,
      }),
    };
    server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", async (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          seen.push(line);
          socket.write(serializeResponse(await handleRequestLine(backend, line)));
          newline = buffer.indexOf("\n");
        }
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
  });

  after(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips an observe-only call", async () => {
    const result = await callBrokerMethod({ socketPath, method: "list_apps" });
    assert.equal(result.count, 2);
    assert.equal(result.route, "workspace");
    assert.equal(result.helper_identity.identifier, "dev.acevra.cua-helper.development");
  });

  it("refuses a response whose claimed grant_owner disagrees with its signature", async () => {
    // A socket that answers with a plausible-looking but unknown identity must not be used.
    const rogueDir = mkdtempSync(join(tmpdir(), "cua-rogue-"));
    const rogueSocket = join(rogueDir, "helper.sock");
    const rogueServer = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", () => {
        socket.write(
          serializeResponse({
            ok: true,
            result: {
              grant_owner: "dev.acevra.cua-helper.development",
              helper_identity: { ...VERIFIED_IDENTITY, identifier: "com.example.not-our-helper" },
            },
          }),
        );
      });
    });
    await new Promise((resolve) => rogueServer.listen(rogueSocket, resolve));
    try {
      await assert.rejects(
        () => callBrokerMethod({ socketPath: rogueSocket, method: "list_apps" }),
        (error) => error.code === "helper_identity_mismatch",
      );
    } finally {
      rogueServer.close();
      rmSync(rogueDir, { recursive: true, force: true });
    }
  });

  it("refuses to send a mutating method at all", async () => {
    const before = seen.length;
    await assert.rejects(
      () => callBrokerMethod({ socketPath, method: "left_click" }),
      (error) => error.code === "not_authorized",
    );
    assert.equal(seen.length, before, "no request should have reached the socket");
  });

  it("fails closed when the environment marks the broker unavailable", async () => {
    process.env[BROKER_UNAVAILABLE_ENV] = "1";
    try {
      await assert.rejects(
        () => callBrokerMethod({ socketPath, method: "list_apps" }),
        (error) => error.code === "unavailable",
      );
    } finally {
      delete process.env[BROKER_UNAVAILABLE_ENV];
    }
  });

  it("reports a useful code when nothing is listening", async () => {
    await assert.rejects(
      () => callBrokerMethod({ socketPath: join(dir, "absent.sock"), method: "list_apps" }),
      (error) => error.code === "connect_failed",
    );
  });

  it("derives health from the identity the helper verified for itself", async () => {
    const health = await probeHelperHealth(socketPath, { timeoutMs: 2000 });
    assert.equal(health.bundleId, "dev.acevra.cua-helper.development");
    assert.equal(health.pid, 4242);
    assert.equal(health.verified, true);
  });
});

describe("Computer Use runtime", () => {
  let dir;
  let socketPath;
  let server;
  let seen = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cua-runtime-test-"));
    socketPath = join(dir, "helper.sock");
    const backend = {
      list_apps: async () => ({
        count: 1,
        route: "workspace",
        effect: "confirmed",
        helper_identity: VERIFIED_IDENTITY,
      }),
      observe: async (params) => ({
        pid: params.pid,
        route: "ax",
        effect: "partial",
        helper_identity: VERIFIED_IDENTITY,
        image: {
          ok: true,
          path: "/Users/someone/.zcode/computer-use/observations/abc.png",
          observation_id: "abc",
          width: 100,
          height: 50,
          blank: false,
        },
      }),
      press: async (params) => ({
        operation: "press",
        semantic_ref: params.semantic_ref,
        classification: "BEST_EFFORT_BACKGROUND",
        route: "accessibility_action",
        effect: "unknown",
        evidence: [{ api_status: 0, verification: "unproven" }],
        helper_identity: VERIFIED_IDENTITY,
      }),
    };
    server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", async (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          seen.push(line);
          socket.write(serializeResponse(await handleRequestLine(backend, line)));
          newline = buffer.indexOf("\n");
        }
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
  });

  after(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dispatches an observation tool to the broker", async () => {
    const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
    const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: {} });
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.route, "workspace");
  });

  it("maps get_app_state onto observe and forwards the arguments", async () => {
    const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
    const result = await runtime.execute({
      toolName: "get_app_state",
      arguments: { pid: 7 },
      context: {},
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.pid, 7);
    assert.equal(parsed.effect, "partial");
  });

  it("routes provider-independent semantic press and preserves unknown effect", async () => {
    const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
    const result = await runtime.execute({
      toolName: "computer.press",
      arguments: { semantic_ref: "opaque-ref" },
      context: {},
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.operation, "press");
    assert.equal(parsed.semantic_ref, "opaque-ref");
    assert.equal(parsed.effect, "unknown");
    assert.equal(parsed.evidence[0].verification, "unproven");
  });

  it("never hands a host filesystem path to the model", async () => {
    const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
    const result = await runtime.execute({
      toolName: "screenshot",
      arguments: { pid: 7 },
      context: {},
    });
    const text = result.content[0].text;
    assert.equal(text.includes("/Users/"), false, text);
    assert.equal(text.includes("someone/.zcode"), false, text);
    const parsed = JSON.parse(text);
    assert.equal(parsed.image.path, undefined);
    assert.equal(parsed.image.reference, "helper-observation:abc");
    // The facts a caller reasons about survive the strip.
    assert.equal(parsed.image.width, 100);
    assert.equal(parsed.image.blank, false);
  });

  it("keeps arbitrary input tools fail-closed without touching the socket", async () => {
    const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
    const before = seen.length;
    for (const toolName of [
      "left_click",
      "type",
      "key",
      "scroll",
      "kill_app",
      "unknown_actuator",
    ]) {
      const result = await runtime.execute({ toolName, arguments: {}, context: {} });
      assert.equal(result.isError, true, `${toolName} must fail closed`);
      assert.match(result.content[0].text, /supported tools/);
    }
    assert.equal(seen.length, before, "no mutating call may reach the socket");
  });

  it("surfaces a broker failure as an error result rather than throwing", async () => {
    const runtime = createComputerUseRuntime({ brokerSocketPath: join(dir, "absent.sock") });
    const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /connect_failed/);
  });

  it("redacts the host path that a failure message carries", async () => {
    // "No Helper is listening yet" is the ordinary first-use case, and node:net names the socket
    // path in that error, so the failure text is the one model-facing string that needs redaction.
    const runtime = createComputerUseRuntime({ brokerSocketPath: join(dir, "absent.sock") });
    const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: {} });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text.includes("absent.sock"), false, result.content[0].text);
    assert.equal(/\/(Users|private|var|tmp|Volumes)\//.test(result.content[0].text), false);
    assert.match(result.content[0].text, /redacted-host-path/);
  });
});
