import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "./ports.js";

/** Descriptive facts a device may advertise; NOT permission grants. Closed, extensible set. */
export const DEVICE_CAPABILITIES = [
  "computerUse",
  "shell",
  "files",
  "git",
  "longTasks",
  "minecraft",
] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];
export const DEVICE_TYPES = ["desktop", "node"] as const;
export const DEVICE_PLATFORMS = ["darwin", "win32", "linux"] as const;

/** A device is online if it checked in within this window; otherwise offline. */
export const PRESENCE_WINDOW_MS = 90_000;

export interface DeviceView {
  id: string;
  type: (typeof DEVICE_TYPES)[number];
  platform: (typeof DEVICE_PLATFORMS)[number];
  displayName: string;
  capabilities: DeviceCapability[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  presence: "online" | "offline" | "revoked";
}

interface DeviceRow {
  id: string;
  account_id: string;
  installation_id: string;
  type: DeviceView["type"];
  platform: DeviceView["platform"];
  display_name: string;
  capabilities: string[];
  created_at: Date | string;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

/** Never includes installation_id, device_key_id or account_id. */
export function toDeviceView(row: DeviceRow, now = Date.now()): DeviceView {
  const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  return {
    id: row.id,
    type: row.type,
    platform: row.platform,
    displayName: row.display_name,
    capabilities: row.capabilities.filter((c): c is DeviceCapability =>
      (DEVICE_CAPABILITIES as readonly string[]).includes(c),
    ),
    createdAt: iso(row.created_at)!,
    lastSeenAt: iso(row.last_seen_at),
    revokedAt: iso(row.revoked_at),
    presence: row.revoked_at ? "revoked" : now - seen <= PRESENCE_WINDOW_MS ? "online" : "offline",
  };
}

export interface RegisterInput {
  installationId: string;
  type: DeviceView["type"];
  platform: DeviceView["platform"];
  displayName: string;
  capabilities: DeviceCapability[];
}

export type RegisterResult =
  | { ok: true; device: DeviceView; created: boolean }
  | { ok: false; reason: "installation_bound" | "device_revoked" };

export function createDeviceService(db: SqlExecutor, clock: () => number = Date.now) {
  return {
    async register(accountId: string, input: RegisterInput): Promise<RegisterResult> {
      return db.transaction(async (tx) => {
        const existing = await tx.query<DeviceRow>(
          "SELECT * FROM devices WHERE installation_id = $1 FOR UPDATE",
          [input.installationId],
        );
        const row = existing.rows[0];
        if (row) {
          // Another account's installation is never silently transferred.
          if (row.account_id !== accountId) return { ok: false, reason: "installation_bound" };
          // A revoked device is never resurrected by re-registering.
          if (row.revoked_at) return { ok: false, reason: "device_revoked" };
          // Idempotent: same installation resolves to the same device. The user-chosen
          // name is kept; descriptive facts and presence are refreshed.
          const updated = await tx.query<DeviceRow>(
            `UPDATE devices SET platform = $2, capabilities = $3, last_seen_at = $4
             WHERE id = $1 RETURNING *`,
            [row.id, input.platform, input.capabilities, new Date(clock())],
          );
          return { ok: true, created: false, device: toDeviceView(updated.rows[0]!, clock()) };
        }
        const created = await tx.query<DeviceRow>(
          `INSERT INTO devices (id, account_id, installation_id, type, platform, display_name, capabilities, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            randomUUID(),
            accountId,
            input.installationId,
            input.type,
            input.platform,
            input.displayName,
            input.capabilities,
            new Date(clock()),
          ],
        );
        return { ok: true, created: true, device: toDeviceView(created.rows[0]!, clock()) };
      });
    },
    async list(accountId: string): Promise<DeviceView[]> {
      const rows = await db.query<DeviceRow>(
        "SELECT * FROM devices WHERE account_id = $1 ORDER BY created_at",
        [accountId],
      );
      return rows.rows.map((row) => toDeviceView(row, clock()));
    },
    /** All mutations scope by account_id: another account's id behaves as nonexistent. */
    async rename(accountId: string, id: string, displayName: string) {
      const result = await db.query<DeviceRow>(
        `UPDATE devices SET display_name = $3 WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING *`,
        [id, accountId, displayName],
      );
      return result.rows[0] ? toDeviceView(result.rows[0], clock()) : null;
    },
    async heartbeat(accountId: string, id: string) {
      const result = await db.query<DeviceRow>(
        `UPDATE devices SET last_seen_at = $3 WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING *`,
        [id, accountId, new Date(clock())],
      );
      if (result.rows[0])
        return { status: "ok" as const, device: toDeviceView(result.rows[0], clock()) };
      const revoked = await db.query(
        "SELECT 1 FROM devices WHERE id = $1 AND account_id = $2 AND revoked_at IS NOT NULL",
        [id, accountId],
      );
      return { status: revoked.rows.length ? ("revoked" as const) : ("not_found" as const) };
    },
    async revoke(accountId: string, id: string) {
      const result = await db.query<DeviceRow>(
        `UPDATE devices SET revoked_at = COALESCE(revoked_at, $3) WHERE id = $1 AND account_id = $2 RETURNING *`,
        [id, accountId, new Date(clock())],
      );
      return result.rows[0] ? toDeviceView(result.rows[0], clock()) : null;
    },
  };
}
export type DeviceService = ReturnType<typeof createDeviceService>;
