// Phase 2 (specs/computer-use.md "Structured transport errors"): every layer keeps a stable code,
// the runtime maps it to one canonical code, and nothing reaches the model as "(unknown): failed".
//
// Run: node --test packages/zcode-cua/test/transport-errors.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { callBrokerMethod } from "../broker.js";
import { createComputerUseRuntime } from "../index.js";
import {
  CANONICAL_FAILURE_CODES,
  annotateHelperFailure,
  canonicalFailureCode,
  classifyThrownFailure,
} from "../transport-errors.js";

const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

describe("canonical failure codes", () => {
  it("covers every code the Phase 2 contract names", () => {
    for (const code of [
      "helper_disconnected",
      "helper_exited",
      "connection_closed",
      "connection_generation_changed",
      "invalid_lease",
      "lease_expired",
      "lease_not_owned",
      "exclusive_busy",
      "protected_grant_expired",
      "user_takeover",
      "injection_failed",
      "unsupported_action",
    ]) {
      assert.ok(Object.hasOwn(CANONICAL_FAILURE_CODES, code), code);
      assert.equal(typeof CANONICAL_FAILURE_CODES[code].recoverable, "boolean", code);
    }
  });

  it("maps layer codes and keeps specific ones", () => {
    assert.equal(canonicalFailureCode("connect_failed"), "helper_disconnected");
    assert.equal(canonicalFailureCode("interrupted"), "user_takeover");
    assert.equal(canonicalFailureCode("invalid_key"), "unsupported_action");
    assert.equal(canonicalFailureCode("stale_geometry"), "stale_geometry");
    assert.equal(canonicalFailureCode(undefined), "unknown");
  });

  it("a dead Helper is recoverable helper_disconnected, and the original code is preserved", () => {
    const failure = classifyThrownFailure(
      Object.assign(new Error("x"), {
        code: "connect_failed",
        details: { delivery: "not_sent" },
      }),
      { socketGone: true },
    );
    assert.deepEqual(failure, {
      code: "helper_disconnected",
      original_code: "connect_failed",
      recoverable: true,
      delivery: "not_sent",
    });
    const untyped = classifyThrownFailure(new Error("failed"), {
      socketGone: true,
    });
    assert.equal(untyped.code, "helper_disconnected");
    assert.equal(untyped.original_code, "unknown");
  });

  it("relay metadata (delivery, generation) survives classification", () => {
    const failure = classifyThrownFailure(
      Object.assign(new Error("gone"), {
        code: "helper_exited",
        details: { delivery: "unknown", connection_generation: 3 },
      }),
    );
    assert.equal(failure.code, "helper_exited");
    assert.equal(failure.delivery, "unknown");
    assert.equal(failure.connection_generation, 3);
  });

  it("annotates a Helper refusal with the canonical code and keeps the Helper's code", () => {
    const annotated = annotateHelperFailure({
      effect: "refused",
      code: "interrupted",
    });
    assert.equal(annotated.code, "user_takeover");
    assert.equal(annotated.original_code, "interrupted");
    assert.equal(annotated.recoverable, false);
    const kept = annotateHelperFailure({
      effect: "refused",
      code: "lease_expired",
    });
    assert.equal(kept.code, "lease_expired");
    assert.equal(kept.original_code, undefined);
    assert.equal(kept.recoverable, true);
  });
});

describe("broker client transport failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "cua-transport-errors-"));
  const servers = [];
  after(() => {
    for (const server of servers) server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a connection closed before any answer is connection_closed at once, not a timeout", async () => {
    const socketPath = join(dir, "close.sock");
    const server = createServer((socket) => socket.once("data", () => socket.destroy()));
    servers.push(server);
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const started = Date.now();
    await assert.rejects(
      callBrokerMethod({
        socketPath,
        method: "list_apps",
        timeoutMs: 5_000,
        requireVerifiedIdentity: false,
      }),
      (error) => {
        assert.equal(error.code, "connection_closed");
        assert.equal(error.details?.delivery, "unknown", "the request was written");
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000, "failed promptly instead of waiting for the timeout");
  });

  it("relayed error metadata reaches the caller", async () => {
    const socketPath = join(dir, "relay.sock");
    const server = createServer((socket) =>
      socket.once("data", () =>
        socket.end(
          `${JSON.stringify({ ok: false, error: { message: "no helper", code: "helper_disconnected", delivery: "not_sent", connection_generation: 4 } })}\n`,
        ),
      ),
    );
    servers.push(server);
    await new Promise((resolve) => server.listen(socketPath, resolve));
    await assert.rejects(
      callBrokerMethod({
        socketPath,
        method: "list_apps",
        requireVerifiedIdentity: false,
      }),
      (error) => {
        assert.equal(error.code, "helper_disconnected");
        assert.deepEqual(error.details, {
          delivery: "not_sent",
          connection_generation: 4,
        });
        return true;
      },
    );
  });

  it("a missing Helper reaches the model typed and recoverable, never (unknown): failed", async () => {
    const cua = createComputerUseRuntime({
      brokerSocketPath: join(dir, "missing.sock"),
      platform: "darwin",
      allowForegroundControl: () => true,
      leaseAuthority: {
        async admission() {
          return { paused: false };
        },
        async reportActivity() {
          return { accepted: true };
        },
      },
    });
    const result = await cua.execute({
      toolName: "list_apps",
      arguments: {},
      context: LOCAL,
    });
    const text = result.content[0].text;
    assert.doesNotMatch(text, /\(unknown\)/u);
    assert.equal(result.structuredContent.code, "helper_disconnected");
    assert.equal(result.structuredContent.recoverable, true);
    assert.equal(result.structuredContent.original_code, "connect_failed");
  });
});
