// Phase 2 (structured transport errors): a Helper whose session socket is gone must surface as a
// typed, recoverable `helper_disconnected`, never as "(unknown): failed". Proven installed
// 92454874: the Helper exited mid-lease (idle/host-disconnect path) and the model saw an
// unactionable opaque failure for the rest of the task.
//
// Run: node --test packages/zcode-cua/test/helper-disconnected.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createComputerUseRuntime } from "../index.js";

const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

function authority() {
  return {
    async admission() {
      return { paused: false };
    },
    async reportActivity() {
      return { accepted: true };
    },
  };
}

describe("a dead Helper surfaces as typed helper_disconnected", () => {
  const dir = mkdtempSync(join(tmpdir(), "cua-helper-disconnected-"));
  // No server is ever started on this path: the Helper (and its socket) is gone.
  const missingSocket = join(dir, "missing.sock");

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("names helper_disconnected and says it is recoverable", async () => {
    const cua = createComputerUseRuntime({
      brokerSocketPath: missingSocket,
      platform: "darwin",
      allowForegroundControl: () => true,
      leaseAuthority: authority(),
    });
    const result = await cua.execute({
      toolName: "list_apps",
      arguments: {},
      context: LOCAL,
    });
    assert.equal(result.isError, true);
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /helper_disconnected/u, text);
    assert.match(text, /recoverable/u, text);
    assert.doesNotMatch(text, /\(unknown\)/u, "the opaque code must not reach the model");
    assert.equal(result.structuredContent?.code, "helper_disconnected");
  });
});
