/**
 * The runtime must carry the captured session capability itself.
 *
 * Packaged acceptance of the managed-helper capability work ended in
 * `missing_session_capability` with a healthy Helper session, and a presence-only trace of the call
 * boundary showed why:
 *
 *   local-broker-rpc method=list_apps localToken=present envBrokerToken=absent
 *   broker-call      method=list_apps argToken=absent   envToken=absent  envSocket=absent
 *
 * The trusted plugin host restores the Helper credentials for exactly the window in which the stdio
 * MCP server process is created and then clears them from its environment. The socket survived that
 * (the runtime captures it), but the capability did not: `callBrokerMethod` reads the token from the
 * environment at *call* time, by which point it is gone, so every real request went out without a
 * capability and the hardened relay refused it.
 *
 * These tests lock the fix: the runtime captures the capability with the socket and sends it on
 * every relay call, even after the environment no longer has it, and it never invents one.
 *
 * Run: node --test packages/zcode-cua/test/runtime-broker-token.test.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { BROKER_TOKEN_ENV } from "../broker.js";
import { createComputerUseRuntime } from "../index.js";

const CAPABILITY = "c".repeat(64);
const VERIFIED_IDENTITY = Object.freeze({
  verified: true,
  identifier: "dev.acevra.cua-helper.development",
  team_id: "",
  cd_hash: "d2da364aa8e974b717f4acd1e16948867c0d7931",
  requirement: 'identifier "dev.acevra.cua-helper.development"',
  ad_hoc: false,
  pid: 4242,
  expected_identifier: "",
});
const LOCAL = Object.freeze({
  sessionId: "session-capability",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

describe("runtime session capability", () => {
  let dir;
  let socketPath;
  let server;
  let seenTokens;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cua-runtime-token-"));
    socketPath = join(dir, "helper.sock");
    seenTokens = [];
    server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        seenTokens.push(request.token);
        // The hardened relay's own admission rule: no capability, no service.
        if (request.token !== CAPABILITY) {
          socket.write(
            `${JSON.stringify({
              id: request.id ?? null,
              ok: false,
              error: {
                code:
                  typeof request.token === "string" ? "wrong_caller" : "missing_session_capability",
                message:
                  typeof request.token === "string"
                    ? "the presented session capability is not valid"
                    : "the session capability token is required",
              },
            })}\n`,
          );
          return;
        }
        socket.write(
          `${JSON.stringify({
            id: request.id ?? null,
            ok: true,
            result: {
              apps: [{ pid: 7, bundle_id: "com.apple.TextEdit", name: "TextEdit" }],
              helper_identity: VERIFIED_IDENTITY,
            },
          })}\n`,
        );
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env[BROKER_TOKEN_ENV];
  });

  function runtimeWith(options) {
    return createComputerUseRuntime({
      brokerSocketPath: socketPath,
      platform: "darwin",
      allowForegroundControl: () => true,
      ...options,
    });
  }

  it("sends the captured capability even though the environment no longer has it", async () => {
    delete process.env[BROKER_TOKEN_ENV];
    const runtime = runtimeWith({ brokerToken: CAPABILITY });
    const result = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: LOCAL,
    });
    const text = JSON.stringify(result);
    assert.match(text, /TextEdit/, "the relay answered, so the capability was accepted");
    assert.equal(seenTokens.at(-1), CAPABILITY);
  });

  it("falls back to the environment when no capability was captured", async () => {
    process.env[BROKER_TOKEN_ENV] = CAPABILITY;
    const runtime = runtimeWith({});
    await runtime.execute({ toolName: "list_apps", arguments: {}, context: LOCAL });
    assert.equal(seenTokens.at(-1), CAPABILITY);
  });

  it("never invents a capability: without one the relay refuses", async () => {
    delete process.env[BROKER_TOKEN_ENV];
    const runtime = runtimeWith({});
    const result = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: LOCAL,
    });
    assert.equal(seenTokens.at(-1), undefined, "no token may be sent when none was captured");
    assert.match(JSON.stringify(result), /missing_session_capability/);
  });
});
