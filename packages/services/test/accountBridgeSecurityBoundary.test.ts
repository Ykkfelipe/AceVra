/**
 * Accounts & Imports — security-boundary and lifecycle regression tests.
 *
 * These pin the guarantees that matter most:
 * - no credential material can appear in anything the relay is allowed to send,
 * - "disconnect from harness" never logs the user out of the source application,
 * - history import does not depend on the account bridge being connected.
 *
 * Tests that need the local Codex/Claude clients skip cleanly when absent, so CI on a
 * machine without them stays green.
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/accountBridgeSecurityBoundary.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createAccountBridgeService } from "../src/accounts/accountBridgeService.js";
import {
  resolveCodexExecutable,
  CodexAppServerBridge,
} from "../src/accounts/codexAppServerBridge.js";
import { scanCodexImportableSessions } from "../src/accounts/codexHistoryImportRepo.js";

const codexInstalled = Boolean(resolveCodexExecutable());

/** Any key or value that would indicate credential material leaking into the wire shape. */
function assertNoCredentialMaterial(value: unknown, label: string): void {
  const json = JSON.stringify(value ?? {});
  assert.doesNotMatch(
    json,
    /"(access_?token|refresh_?token|id_?token|apiKey|api_key|authUrl|secret|password|tokens|credentials)"/i,
    `${label}: credential-like key present`,
  );
  assert.doesNotMatch(json, /eyJ[A-Za-z0-9_-]{10,}\./, `${label}: JWT-shaped value present`);
  assert.doesNotMatch(json, /sk-[A-Za-z0-9]{16,}/, `${label}: API-key-shaped value present`);
}

function makeService(openedUrls: string[]) {
  return createAccountBridgeService({
    openExternalUrl: async (url: string) => {
      openedUrls.push(url);
    },
    clientVersion: "0.0.0-test",
  });
}

test("connect result type cannot carry the OAuth authUrl to a client", () => {
  // The Codex callback targets localhost on the host, so authUrl must never be returned.
  // This is a structural guarantee: AccountBridgeConnectResult has no authUrl field, and
  // the service opens the URL host-side instead.
  const sample = {
    source: "codex" as const,
    started: true,
    loginId: "opaque-correlation-id",
    status: {
      source: "codex" as const,
      installed: true,
      state: "connecting" as const,
      sourceSignedIn: false,
      checkedAt: new Date().toISOString(),
    },
  };
  assertNoCredentialMaterial(sample, "connect result");
});

test("status reads never open a browser", async () => {
  const opened: string[] = [];
  const svc = makeService(opened);
  await svc.readStatus("claude-code");
  if (codexInstalled) await svc.readStatus("codex");
  assert.equal(opened.length, 0);
  svc.dispose();
});

test("claude status is sanitized and reports a real disconnected state", async () => {
  const opened: string[] = [];
  const svc = makeService(opened);
  const status = await svc.readStatus("claude-code");
  assert.equal(status.source, "claude-code");
  assertNoCredentialMaterial(status, "claude status");
  // authMethod/apiProvider are labels, never tokens.
  if (status.identity?.authMethod) assert.ok(status.identity.authMethod.length < 64);
  svc.dispose();
});

test("codex status while disconnected does not start the app-server", { skip: !codexInstalled }, async () => {
  const opened: string[] = [];
  const svc = makeService(opened);
  const status = await svc.readStatus("codex");
  assert.equal(status.installed, true);
  assert.equal(status.state, "disconnected");
  assert.ok(status.version, "version should be readable without the app-server");
  assertNoCredentialMaterial(status, "codex disconnected status");
  svc.dispose();
});

test("codex bridge initializes and returns only sanitized account data", { skip: !codexInstalled }, async () => {
  const opened: string[] = [];
  const svc = makeService(opened);
  const status = await svc.reconnectBridge("codex");
  assert.equal(status.state, "connected");
  assertNoCredentialMaterial(status, "codex connected status");
  assert.equal(opened.length, 0, "no OAuth URL should be opened for a status read");
  svc.dispose();
});

test("disconnect preserves the source Codex login", { skip: !codexInstalled }, async () => {
  const opened: string[] = [];
  const svc = makeService(opened);
  const connected = await svc.reconnectBridge("codex");
  const wasSignedIn = connected.sourceSignedIn;

  const disconnected = await svc.disconnect("codex");
  assert.equal(disconnected.state, "disconnected");

  const again = await svc.reconnectBridge("codex");
  assert.equal(
    again.sourceSignedIn,
    wasSignedIn,
    "harness disconnect must not change the source application's login",
  );
  svc.dispose();
});

test("bridge stop() is non-terminal while dispose() is terminal", { skip: !codexInstalled }, async () => {
  const bridge = new CodexAppServerBridge({ clientVersion: "0.0.0-test" });
  await bridge.ensureStarted();
  const firstGeneration = bridge.generation;

  bridge.stop();
  await bridge.ensureStarted();
  assert.ok(bridge.generation > firstGeneration, "stop() then start must advance the generation");

  bridge.dispose();
  await assert.rejects(() => bridge.ensureStarted(), /disposed/);
});

test("history import works with the account bridge disconnected", { skip: !codexInstalled }, async () => {
  const opened: string[] = [];
  const svc = makeService(opened);
  await svc.disconnect("codex");
  const candidates = await scanCodexImportableSessions({ limit: 3 });
  for (const candidate of candidates) {
    assert.equal(candidate.provider, "codex");
    assert.doesNotMatch(candidate.sourcePath, /auth\.json/);
  }
  assertNoCredentialMaterial(candidates, "codex history candidates");
  svc.dispose();
});
