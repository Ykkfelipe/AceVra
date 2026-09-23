import assert from "node:assert/strict";
import test from "node:test";
import { readAccountStatusWithDeadline } from "../src/lib/accountStatusRequest.js";

test("status RPC rejection becomes retryable terminal error, not missing/loading", async () => {
  const status = await readAccountStatusWithDeadline("codex", async () => {
    throw new Error("host unavailable");
  });
  assert.equal(status.state, "error");
  assert.equal(status.installed, true);
});

test("status RPC that never settles reaches a terminal error by its deadline", async () => {
  const status = await readAccountStatusWithDeadline("claude-code", () => new Promise(() => {}), 5);
  assert.equal(status.state, "error");
  assert.equal(status.source, "claude-code");
  assert.equal(status.error, "status_read_failed");
});

test("successful source status is preserved", async () => {
  const expected = {
    source: "codex" as const,
    installed: true,
    state: "connected" as const,
    sourceSignedIn: true,
    sourceSignInChecked: true,
    checkedAt: "2026-09-23T00:00:00.000Z",
  };
  assert.deepEqual(await readAccountStatusWithDeadline("codex", async () => expected, 5), expected);
});
