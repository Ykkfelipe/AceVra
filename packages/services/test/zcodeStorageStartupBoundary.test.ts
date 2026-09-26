import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import test from "node:test";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "../src/zcode-agent/zcodeStdioTransport.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "../src/zcode-agent/zcodeProtocolTransport.js";

function validState(phase: "checking" | "failed" = "checking") {
  return {
    schemaVersion: 1,
    attemptId: "attempt-diagnostic",
    sequence: 1,
    databaseId: "session-diagnostic",
    databaseKind: "session",
    phase,
    elapsedMs: 3,
    ...(phase === "failed" ? { errorCode: "sql_failed" } : {}),
  };
}

function createFakeChild(): {
  child: ChildProcessWithoutNullStreams;
  emitFrame(frame: unknown): void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    killed: false,
    exitCode: null,
    signalCode: null,
    pid: 81_239,
  }) as unknown as ChildProcessWithoutNullStreams;
  return {
    child,
    emitFrame: (frame) => stdout.write(`${JSON.stringify(frame)}\n`),
  };
}

class DiagnosticTransport implements ZCodeProtocolTransport {
  readonly kind = "memory" as const;
  private readonly messages = new Emitter<ZCodeProtocolMessage>();
  private readonly closes = new Emitter<ZCodeProtocolTransportClosedEvent>();
  readonly onMessage = this.messages.event;
  readonly onClose = this.closes.event;

  async send(): Promise<void> {}
  dispose(): void {
    this.messages.dispose();
    this.closes.dispose();
  }
  emit(message: unknown): void {
    this.messages.fire(message as ZCodeProtocolMessage);
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("CASE A: startup frame after client subscription is accepted by the gate", async () => {
  const source = createFakeChild();
  const transport = new ZCodeStdioTransport(source.child);
  const client = new ZCodeProtocolClient(transport, { requireStorageStartup: true });

  source.emitFrame({ method: "startup/storageState", params: validState() });
  await settle();

  assert.equal(client.storageStartup.snapshot?.phase, "checking");
  client.dispose();
});

test("CASE B: frame emitted before client subscription is not replayed", async () => {
  const source = createFakeChild();
  const transport = new ZCodeStdioTransport(source.child);

  source.emitFrame({ method: "startup/storageState", params: validState() });
  await settle();
  const client = new ZCodeProtocolClient(transport, { requireStorageStartup: true });
  await settle();

  assert.equal(client.storageStartup.snapshot, undefined);
  assert.equal(client.storageStartup.isWaiting, true);
  client.dispose();
});

test("CASE C: client exposes storage schema rejection for invalid startup state", () => {
  const transport = new DiagnosticTransport();
  const client = new ZCodeProtocolClient(transport, { requireStorageStartup: true });

  transport.emit({ method: "startup/storageState", params: { phase: "checking" } });

  assert.equal(client.storageStartup.snapshot, undefined);
  assert.equal(client.storageStartup.isWaiting, true);
  client.dispose();
});

test("CASE D: valid startup frame after terminal state is rejected", () => {
  const transport = new DiagnosticTransport();
  const client = new ZCodeProtocolClient(transport, { requireStorageStartup: true });

  transport.emit({ method: "startup/storageState", params: validState("failed") });
  assert.equal(client.storageStartup.snapshot?.phase, "failed");
  transport.emit({
    method: "startup/storageState",
    params: { ...validState(), sequence: 2 },
  });

  assert.equal(client.storageStartup.snapshot?.phase, "failed");
  client.dispose();
});
