/**
 * Execution presentation rules (M2E): targets come only from ExecutionTarget data and are shown
 * truthfully; task cards are derived only from TaskView + TaskEvents and never expose the
 * command line.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AccountDevice, ExecutionTarget, TaskEvent } from "@zcode/shared";
import {
  appendTaskEvents,
  buildTargetOptions,
  describeDeviceRole,
  resolveSelectedTarget,
  resolveTaskStatus,
} from "../src/account/executionPresentation.js";

const target = (overrides: Partial<ExecutionTarget>): ExecutionTarget => ({
  id: "local",
  type: "desktop",
  displayName: "Studio Mac",
  online: true,
  capabilities: ["shell"],
  isThisDevice: true,
  available: true,
  ...overrides,
});
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

test("target options: this device first, nodes by name, unavailable disabled with a reason", () => {
  const options = buildTargetOptions([
    target({ id: "n2", type: "node", displayName: "Zed Box", isThisDevice: false }),
    target({}),
    target({
      id: "n1",
      type: "node",
      displayName: "Dell",
      isThisDevice: false,
      online: false,
      available: false,
      unavailableReason: "offline",
    }),
    target({
      id: "n3",
      type: "node",
      displayName: "Bare",
      isThisDevice: false,
      available: false,
      unavailableReason: "no_shell_service",
    }),
  ]);
  assert.deepEqual(
    options.map((o) => [o.id, o.label, o.disabled, o.status]),
    [
      ["local", "Studio Mac", false, "available"],
      ["n3", "Bare", true, "cannotRun"],
      ["n1", "Dell", true, "offline"],
      ["n2", "Zed Box", false, "available"],
    ],
  );
});

test("selection resolves to auto, a live option, or an explicit missing state", () => {
  const targets = [target({}), target({ id: "n1", displayName: "Dell", isThisDevice: false })];
  assert.deepEqual(resolveSelectedTarget("auto", targets), { kind: "auto" });
  const picked = resolveSelectedTarget("n1", targets);
  assert.equal(picked.kind === "target" && picked.option.label, "Dell");
  assert.deepEqual(resolveSelectedTarget("gone", targets), { kind: "missing" });
  // Before targets have loaded a concrete choice is not reported as missing.
  assert.deepEqual(resolveSelectedTarget("n1", null), { kind: "loading" });
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

test("device role is This device or Node, never a capability list", () => {
  const device = { id: "d1", type: "node" } as AccountDevice;
  assert.equal(describeDeviceRole(device, "d0"), "node");
  assert.equal(describeDeviceRole({ ...device, type: "desktop" }, "d0"), "otherDesktop");
  assert.equal(describeDeviceRole(device, "d1"), "thisDevice");
});
