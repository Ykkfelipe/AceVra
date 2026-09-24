import assert from "node:assert/strict";
import test from "node:test";
import { isCuaPermissionStatusAvailable } from "@zcode/services";
import {
  persistCuaPermissionStatus,
  readCachedCuaPermissionStatus,
} from "../src/lib/cuaPermissionStatusCache.js";

function memoryStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const now = 1_000_000_000_000;
const availableStatus = {
  available: true as const,
  grantOwner: "AceVra Computer Use.app",
  accessibility: "granted" as const,
  accessibilityProbeOk: true,
  screenRecording: "granted" as const,
  screenCaptureProbeOk: true,
  screenCaptureProbeState: "ok" as const,
};

test("cached permission status preserves the live available Helper contract", () => {
  const storage = memoryStorage();
  persistCuaPermissionStatus(availableStatus, storage, now);

  const cached = readCachedCuaPermissionStatus(storage, now + 1);
  assert.ok(cached);
  assert.equal(isCuaPermissionStatusAvailable(cached), true);
  assert.equal(cached.available, true);
  assert.equal(cached.accessibility, "granted");
  assert.equal(cached.screenRecording, "granted");
});

test("unavailable or malformed Helper responses are not restored as cached status", () => {
  const storage = memoryStorage();
  persistCuaPermissionStatus({ available: false, reason: "helper_not_running" }, storage, now);
  assert.equal(readCachedCuaPermissionStatus(storage, now + 1), null);

  storage.data.set(
    "zcode-cua-permission-status",
    JSON.stringify({
      savedAt: now,
      status: { grantOwner: "AceVra Computer Use.app", accessibility: "granted" },
    }),
  );
  assert.equal(readCachedCuaPermissionStatus(storage, now + 1), null);
});
