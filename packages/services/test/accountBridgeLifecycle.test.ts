import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAccountBridgeService } from "../src/accounts/accountBridgeService.js";
import { CodexAppServerBridge } from "../src/accounts/codexAppServerBridge.js";
import { discoverExecutable } from "../src/accounts/executableDiscovery.js";

async function executable(content: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-account-"));
  const path = join(dir, "client");
  await writeFile(path, `#!/bin/sh\n${content}\n`, "utf8");
  await chmod(path, 0o755);
  return { dir, path };
}

function bridge(account: unknown, usage: unknown = {}, failureMethod?: string) {
  return {
    installed: true,
    executablePath: "/bin/true",
    ensureStarted: async () => {
      if (failureMethod === "initialize") throw new Error("launch failed");
    },
    onNotification: () => () => {},
    call: async (method: string) => {
      if (failureMethod === method || failureMethod === "initialize")
        throw new Error(`${method} failed`);
      if (method === "account/read") return { account };
      if (method === "account/rateLimits/read") return usage;
      return {};
    },
    stop() {},
    dispose() {},
  } as unknown as CodexAppServerBridge;
}

test("executable discovery honors configured paths and PATH, including Apple Silicon PATH entries", async () => {
  const found = await executable("exit 0");
  try {
    assert.equal(discoverExecutable({ name: "client", pathValue: found.dir }), found.path);
    assert.equal(discoverExecutable({ name: "client", configuredPath: found.path }), found.path);
    assert.equal(discoverExecutable({ name: "missing", pathValue: found.dir }), undefined);
  } finally {
    await rm(found.dir, { recursive: true, force: true });
  }
});

test("Codex account reads terminate as disconnected, connected, or error; usage failure is partial", async () => {
  const client = await executable('printf "codex-test\\n"');
  try {
    const signedOut = createAccountBridgeService({
      openExternalUrl: async () => {},
      codexExecutablePath: client.path,
      codexBridge: bridge(null),
    });
    await signedOut.reconnectBridge("codex");
    assert.equal((await signedOut.readStatus("codex")).state, "disconnected");
    signedOut.dispose();

    const signedIn = createAccountBridgeService({
      openExternalUrl: async () => {},
      codexExecutablePath: client.path,
      codexBridge: bridge({ type: "chatgpt", planType: "plus" }, {}, "account/rateLimits/read"),
    });
    await signedIn.reconnectBridge("codex");
    const connected = await signedIn.readStatus("codex");
    assert.equal(connected.state, "connected");
    assert.equal(connected.sourceSignedIn, true);
    assert.equal(connected.usage, undefined);
    signedIn.dispose();

    const failed = createAccountBridgeService({
      openExternalUrl: async () => {},
      codexExecutablePath: client.path,
      codexBridge: bridge(null, {}, "initialize"),
    });
    await failed.reconnectBridge("codex");
    assert.equal((await failed.readStatus("codex")).state, "error");
    failed.dispose();
  } finally {
    await rm(client.dir, { recursive: true, force: true });
  }
});

test("missing Codex executable is not-installed", async () => {
  const service = createAccountBridgeService({
    openExternalUrl: async () => {},
    codexExecutablePath: "/definitely/missing/codex",
    claudeExecutablePath: "/definitely/missing/claude",
  });
  assert.equal((await service.readStatus("codex")).state, "not-installed");
  service.dispose();
});

test("Claude signed-out status is disconnected and launch/status failures terminate", async () => {
  const client = await executable(
    'if [ "$1" = "--version" ]; then echo 2.0.0; else echo \'{"loggedIn":false}\'; fi',
  );
  try {
    const service = createAccountBridgeService({
      openExternalUrl: async () => {},
      claudeExecutablePath: client.path,
    });
    assert.equal((await service.readStatus("claude-code")).state, "disconnected");
    await service.connect("claude-code");
    assert.equal((await service.readStatus("claude-code")).state, "disconnected");
    service.dispose();
  } finally {
    await rm(client.dir, { recursive: true, force: true });
  }
});
