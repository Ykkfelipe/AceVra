/**
 * Computer work presentation rules: work cards are derived only from TaskView + TaskEvents and
 * never expose the command line; computers are described by role, never by capability lists.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AccountDevice, TaskEvent } from "@zcode/shared";
import {
  appendTaskEvents,
  describeDeviceRole,
  resolveTaskStatus,
} from "../src/account/executionPresentation.js";

const event = (
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): TaskEvent => ({
  sequence,
  type,
  ts: "2026-10-01T00:00:00.000Z",
  payload,
});

test("task status is derived from the real task state and terminal events", () => {
  assert.deepEqual(resolveTaskStatus("running", []), { id: "running", active: true });
  assert.deepEqual(resolveTaskStatus("running_unknown", []), {
    id: "connectionLost",
    active: true,
  });
  assert.deepEqual(
    resolveTaskStatus("completed", [event(3, "process.completed", { exitCode: 0 })]),
    {
      id: "completed",
      active: false,
      exitCode: 0,
    },
  );
  assert.deepEqual(
    resolveTaskStatus("failed", [event(3, "process.failed", { reason: "exit", exitCode: 2 })]),
    { id: "failed", active: false, exitCode: 2 },
  );
  assert.deepEqual(
    resolveTaskStatus("cancelled", [event(4, "task.cancelled", { acknowledged: false })]),
    { id: "cancelledUnconfirmed", active: false },
  );
  assert.deepEqual(resolveTaskStatus(null, []), { id: "unknown", active: false });
});

test("live lines keep only the latest output/progress, dedupe by sequence, never the command", () => {
  let lines = appendTaskEvents(
    [],
    [
      event(1, "task.created", { process: { executable: "/usr/bin/secret", args: ["--x"] } }),
      event(2, "process.started", { pid: 42 }),
      event(3, "process.output", { stream: "stdout", text: "71 tests discovered\n" }),
    ],
  );
  assert.deepEqual(
    lines.map((l) => l.text),
    ["71 tests discovered"],
  );
  lines = appendTaskEvents(lines, [
    event(3, "process.output", { stream: "stdout", text: "71 tests discovered\n" }),
    event(4, "process.output", { stream: "stderr", text: "warn: a\nwarn: b\n" }),
    event(5, "process.progress", { message: "42 passed" }),
    event(6, "process.truncated", {}),
  ]);
  assert.deepEqual(
    lines.map((l) => [l.text, l.stream]),
    [
      ["warn: a", "stderr"],
      ["warn: b", "stderr"],
      ["42 passed", "progress"],
    ],
  );
  assert.ok(!JSON.stringify(lines).includes("/usr/bin/secret"));
});

test("computer role is this computer, a connected computer or another desktop, never a capability list", () => {
  const device = { id: "d1", type: "node" } as AccountDevice;
  assert.equal(describeDeviceRole(device, "d0"), "node");
  assert.equal(describeDeviceRole({ ...device, type: "desktop" }, "d0"), "otherDesktop");
  assert.equal(describeDeviceRole(device, "d1"), "thisDevice");
});
