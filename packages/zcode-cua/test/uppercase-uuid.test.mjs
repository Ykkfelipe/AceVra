// CUA-4 uppercase Helper UUID acceptance: the Helper issues observation/lease ids as
// UPPERCASE UUIDs (e.g. A40170B2-A42A-4B35-80EE-F38FDA845C4E). Foreground-control
// validation and control_status must accept them unchanged — the Helper's own
// observation registry lookup is case-sensitive, so the runtime must not normalize
// either. Same bug class as the observation-preview preview-id fix.
//
// Run: node --test packages/zcode-cua/test/uppercase-uuid.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { validForegroundInput } from "../capability-contract.js";
import { createComputerUseRuntime } from "../index.js";

// Real-format Helper-native uppercase observation id (captured live 2026-09-30).
const UPPER_OBSERVATION_ID = "A40170B2-A42A-4B35-80EE-F38FDA845C4E";
const UPPER_LEASE_ID = "6139A6DD-8E10-4D15-825A-AB06949A7034";
const LOWER_LEASE_ID = UPPER_LEASE_ID.toLowerCase();
const LOCAL = Object.freeze({
  sessionId: "session-a",
  turnId: "turn-1",
  runtimeScope: "main",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
});

describe("validForegroundInput accepts Helper-native uppercase UUIDs", () => {
  it("accepts the real uppercase observation id for acquire_control", () => {
    assert.equal(
      validForegroundInput("acquire_control", { observation_id: UPPER_OBSERVATION_ID }),
      true,
    );
  });

  it("accepts real uppercase ids for every lease-carrying foreground method", () => {
    assert.equal(validForegroundInput("release_control", { lease_id: UPPER_LEASE_ID }), true);
    assert.equal(
      validForegroundInput("activate_target", {
        lease_id: UPPER_LEASE_ID,
        observation_id: UPPER_OBSERVATION_ID,
      }),
      true,
    );
    assert.equal(
      validForegroundInput("move_pointer", {
        lease_id: UPPER_LEASE_ID,
        observation_id: UPPER_OBSERVATION_ID,
        point: { x: 10, y: 20 },
      }),
      true,
    );
    assert.equal(
      validForegroundInput("click", {
        lease_id: UPPER_LEASE_ID,
        observation_id: UPPER_OBSERVATION_ID,
        point: { x: 10, y: 20 },
      }),
      true,
    );
    assert.equal(
      validForegroundInput("type_text", {
        lease_id: UPPER_LEASE_ID,
        observation_id: UPPER_OBSERVATION_ID,
        text: "f",
      }),
      true,
    );
    assert.equal(
      validForegroundInput("key_press", {
        lease_id: UPPER_LEASE_ID,
        observation_id: UPPER_OBSERVATION_ID,
        key: "return",
        modifiers: [],
      }),
      true,
    );
    assert.equal(
      validForegroundInput("scroll", {
        lease_id: UPPER_LEASE_ID,
        observation_id: UPPER_OBSERVATION_ID,
        point: { x: 10, y: 20 },
        delta_x: 0,
        delta_y: -120,
      }),
      true,
    );
    assert.equal(
      validForegroundInput("drag", {
        lease_id: UPPER_LEASE_ID,
        observation_id: UPPER_OBSERVATION_ID,
        start: { x: 10, y: 20 },
        end: { x: 40, y: 20 },
      }),
      true,
    );
  });

  it("keeps rejecting malformed ids", () => {
    assert.equal(
      validForegroundInput("acquire_control", {
        observation_id: "A40170B2A42A4B3580EEF38FDA845C4E",
      }),
      false,
    );
    assert.equal(
      validForegroundInput("acquire_control", {
        observation_id: "A40170B2-A42A-4B35-80EE-F38FDA845C4",
      }),
      false,
    );
    assert.equal(
      validForegroundInput("acquire_control", {
        observation_id: "A40170B2-A42A-4B35-80EE-F38FDA845C4G",
      }),
      false,
    );
    assert.equal(validForegroundInput("acquire_control", { observation_id: 42 }), false);
  });

  it("keeps accepting lowercase ids (compatibility)", () => {
    assert.equal(
      validForegroundInput("acquire_control", {
        observation_id: UPPER_OBSERVATION_ID.toLowerCase(),
      }),
      true,
    );
    assert.equal(validForegroundInput("release_control", { lease_id: LOWER_LEASE_ID }), true);
  });
});

describe("control_status accepts a Helper-native uppercase lease UUID", () => {
  let dir;
  let socketPath;
  let server;
  const seen = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cua4-uppercase-uuid-test-"));
    socketPath = join(dir, "helper.sock");
    const backend = {
      control_status: async (params) => ({
        operation: "control_status",
        effect: "confirmed",
        lease_id: params.lease_id,
        lease_state: "active",
        helper_identity: {
          verified: true,
          identifier: "dev.acevra.cua-helper.development",
          team_id: "",
          cd_hash: "d2da364aa8e974b717f4acd1e16948867c0d7931",
          requirement: 'identifier "dev.acevra.cua-helper.development"',
          ad_hoc: false,
          pid: 4242,
          expected_identifier: "",
        },
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
          seen.push(JSON.parse(line).method);
          const { handleRequestLine, serializeResponse } = await import("../broker.js");
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

  function runtime() {
    return createComputerUseRuntime({
      brokerSocketPath: socketPath,
      platform: "darwin",
      allowForegroundControl: () => true,
      leaseAuthority: {
        async beginAcquire() {
          return { leaseId: "authority-lease-1" };
        },
        async commitAcquire() {
          return { accepted: true };
        },
        async release() {
          return { status: "released" };
        },
        async stop() {
          return { status: "already_stopped" };
        },
        async admission() {
          return { paused: false };
        },
        async reportActivity() {
          return { accepted: true };
        },
      },
    });
  }

  it("control_status reads the runtime grant; a legacy uppercase lease id is accepted and ignored", async () => {
    // Phase 4: native lease ids belong to the runtime's ProtectedForegroundGrant binding. The
    // model's legacy argument is still validated case-insensitively, then ignored.
    const cua = runtime();
    const before = seen.length;
    const result = await cua.execute({
      toolName: "computer.control_status",
      arguments: { lease_id: UPPER_LEASE_ID },
      context: LOCAL,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content?.[0]));
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.protectedForeground, "inactive");
    assert.equal(body.lease_id, undefined, "no native lease id is ever shown to the model");
    assert.equal(seen.length, before, "without a grant binding nothing reaches the Helper");
  });

  it("keeps rejecting malformed lease ids before any dispatch", async () => {
    const cua = runtime();
    const before = seen.length;
    const result = await cua.execute({
      toolName: "computer.control_status",
      arguments: { lease_id: "not-a-uuid" },
      context: LOCAL,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /control_status takes no arguments/u);
    assert.equal(seen.length, before, "malformed id must not reach the Helper");
  });
});
