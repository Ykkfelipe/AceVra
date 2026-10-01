import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { NodePaths } from "./dataRoot.js";

export interface PendingPairing {
  pairingId: string;
  /** Short-lived bearer for THIS pairing only; removed on claim/expiry. */
  secret: string;
  code: string;
  expiresAt: string;
}
export interface NodeState {
  apiBaseUrl: string;
  displayName: string;
  platform: "darwin" | "win32" | "linux";
  /** Present once paired. */
  deviceId?: string;
  keyId?: string;
  pairing?: PendingPairing;
}
export type Connection =
  | "connecting"
  | "connected"
  | "offline"
  | "revoked"
  | "auth-failed"
  | "stopped";
export interface NodeStatus {
  connection: Connection;
  pid: number;
  updatedAt: string;
  lastConnectedAt?: string;
  sessionExpiresAt?: string;
}

/** Writes are serialized per file and use unique temp names so concurrent updates cannot collide. */
const queues = new Map<string, Promise<void>>();
function writePrivate(path: string, value: unknown): Promise<void> {
  const next = (queues.get(path) ?? Promise.resolve()).then(() => writeOnce(path, value));
  queues.set(
    path,
    next.catch(() => undefined),
  );
  return next;
}
async function writeOnce(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") await chmod(temp, 0o600);
  await rename(temp, path);
}
async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export const readState = (paths: NodePaths) => readJson<NodeState>(paths.state);
export const writeState = (paths: NodePaths, state: NodeState) => writePrivate(paths.state, state);
export const readStatus = (paths: NodePaths) => readJson<NodeStatus>(paths.status);
export const writeStatus = (paths: NodePaths, status: Omit<NodeStatus, "pid" | "updatedAt">) =>
  writePrivate(paths.status, { ...status, pid: process.pid, updatedAt: new Date().toISOString() });
export const clearNode = async (paths: NodePaths) => {
  await Promise.all([paths.key, paths.state, paths.status].map((p) => rm(p, { force: true })));
};
