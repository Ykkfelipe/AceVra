import {
  createHash,
  createPublicKey,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { DEVICE_CAPABILITIES, DEVICE_PLATFORMS, type DeviceCapability } from "./devices.js";
import type { SqlExecutor } from "./ports.js";

export const PAIRING_TTL_MS = 10 * 60_000;
export const CLAIM_NONCE_TTL_MS = 60_000;
const MAX_FAILED_CLAIMS = 5;
// No 0/O/1/I/L: the code is read aloud and typed by a human.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const b64url = (buffer: Buffer) => buffer.toString("base64url");

export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c))
    ? code
    : null;
}
const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Parses an Ed25519 SPKI public key (base64url DER). Anything else is rejected. */
export function parseEd25519PublicKey(value: unknown): { der: Buffer; keyId: string } | null {
  if (typeof value !== "string" || value.length > 128) return null;
  try {
    const der = Buffer.from(value, "base64url");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return { der, keyId: `k_${b64url(createHash("sha256").update(der).digest()).slice(0, 22)}` };
  } catch {
    return null;
  }
}

/** Verifies an Ed25519 signature (base64url) over a UTF-8 message. */
export function verifySignature(
  publicKeyDer: string,
  message: string,
  signature: unknown,
): boolean {
  if (typeof signature !== "string" || signature.length > 128) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyDer, "base64url"),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
export const claimMessage = (pairingId: string, nonce: string) =>
  `acevra-pair-claim:v1:${pairingId}:${nonce}`;

interface PairingRow {
  id: string;
  secret_hash: string;
  code_hash: string;
  public_key: string;
  key_id: string;
  display_name: string;
  platform: (typeof DEVICE_PLATFORMS)[number];
  capabilities: string[];
  status: "pending" | "approved" | "rejected" | "claimed";
  account_id: string | null;
  device_id: string | null;
  claim_nonce: string | null;
  claim_nonce_expires_at: Date | string | null;
  failed_claims: number;
  created_at: Date | string;
  expires_at: Date | string;
}

export interface PairingPreview {
  id: string;
  displayName: string;
  platform: (typeof DEVICE_PLATFORMS)[number];
  capabilities: DeviceCapability[];
  createdAt: string;
  expiresAt: string;
}
const preview = (row: PairingRow): PairingPreview => ({
  id: row.id,
  displayName: row.display_name,
  platform: row.platform,
  capabilities: row.capabilities.filter((c): c is DeviceCapability =>
    (DEVICE_CAPABILITIES as readonly string[]).includes(c),
  ),
  createdAt: new Date(row.created_at).toISOString(),
  expiresAt: new Date(row.expires_at).toISOString(),
});
const equalHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type NodeStatus = "pending" | "approved" | "rejected" | "expired" | "claimed";

export function createPairingService(db: SqlExecutor, clock: () => number = Date.now) {
  const now = () => new Date(clock());
  const isExpired = (row: PairingRow) => new Date(row.expires_at).getTime() <= clock();

  /** The node proves knowledge of the 256-bit secret; a wrong secret looks like "not found". */
  async function loadForNode(tx: SqlExecutor, id: string, secret: unknown, lock = false) {
    if (typeof secret !== "string" || secret.length > 128) return null;
    const rows = await tx.query<PairingRow>(
      `SELECT * FROM pairings WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
    const row = rows.rows[0];
    return row && equalHash(row.secret_hash, sha256(secret)) ? row : null;
  }

  return {
    /** Node → new pairing. Returns the only copy of the secret and the human code. */
    async create(input: {
      publicKey: string;
      keyId: string;
      displayName: string;
      platform: PairingRow["platform"];
      capabilities: DeviceCapability[];
    }) {
      const secret = b64url(randomBytes(32));
      const id = randomUUID();
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = Array.from(
          { length: CODE_LENGTH },
          () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
        ).join("");
        // Codes must be unambiguous among live pairings.
        const clash = await db.query(
          "SELECT 1 FROM pairings WHERE code_hash = $1 AND status = 'pending' AND expires_at > $2",
          [sha256(code), now()],
        );
        if (clash.rows.length) continue;
        const expiresAt = new Date(clock() + PAIRING_TTL_MS);
        await db.query(
          `INSERT INTO pairings (id, secret_hash, code_hash, public_key, key_id, display_name, platform, capabilities, status, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
          [
            id,
            sha256(secret),
            sha256(code),
            input.publicKey,
            input.keyId,
            input.displayName,
            input.platform,
            input.capabilities,
            expiresAt,
          ],
        );
        return {
          pairingId: id,
          secret,
          code: formatCode(code),
          expiresAt: expiresAt.toISOString(),
        };
      }
      throw new Error("could not allocate a pairing code");
    },
    /** Human lookup by code: only live pending pairings; the code is the sole discovery path. */
    async lookup(code: string): Promise<PairingPreview | null> {
      const rows = await db.query<PairingRow>(
        `SELECT * FROM pairings WHERE code_hash = $1 AND status = 'pending' AND expires_at > $2`,
        [sha256(code), now()],
      );
      return rows.rows[0] ? preview(rows.rows[0]) : null;
    },
    async decide(accountId: string, id: string, decision: "approve" | "reject") {
      return db.transaction(async (tx) => {
        const rows = await tx.query<PairingRow>("SELECT * FROM pairings WHERE id = $1 FOR UPDATE", [
          id,
        ]);
        const row = rows.rows[0];
        if (!row) return { ok: false as const, reason: "not_found" as const };
        if (row.status !== "pending" || isExpired(row)) {
          return {
            ok: false as const,
            reason: row.status === "pending" ? ("expired" as const) : ("not_pending" as const),
          };
        }
        await tx.query(
          decision === "approve"
            ? "UPDATE pairings SET status = 'approved', account_id = $2, approved_at = $3 WHERE id = $1"
            : "UPDATE pairings SET status = 'rejected', account_id = $2 WHERE id = $1",
          decision === "approve" ? [id, accountId, now()] : [id, accountId],
        );
        return { ok: true as const };
      });
    },
    async status(id: string, secret: unknown): Promise<NodeStatus | null> {
      const row = await loadForNode(db, id, secret);
      if (!row) return null;
      if (row.status === "pending" && isExpired(row)) return "expired";
      if (row.status === "approved" && isExpired(row)) return "expired";
      return row.status;
    },
    /** Approved pairing → one-time nonce the node must sign with its private key. */
    async challenge(id: string, secret: unknown) {
      return db.transaction(async (tx) => {
        const row = await loadForNode(tx, id, secret, true);
        if (!row) return { ok: false as const, reason: "not_found" as const };
        if (row.status !== "approved" || isExpired(row)) {
          return {
            ok: false as const,
            reason: isExpired(row) ? ("expired" as const) : ("not_approved" as const),
            status: row.status,
          };
        }
        const nonce = b64url(randomBytes(24));
        const expires = new Date(clock() + CLAIM_NONCE_TTL_MS);
        await tx.query(
          "UPDATE pairings SET claim_nonce = $2, claim_nonce_expires_at = $3 WHERE id = $1",
          [id, nonce, expires],
        );
        return { ok: true as const, nonce, expiresAt: expires.toISOString() };
      });
    },
    /**
     * Claim = approved pairing + signature over the server nonce from the private key
     * matching the public key given at pairing time. The code/secret alone never suffices.
     */
    async claim(id: string, input: { secret: unknown; nonce: unknown; signature: unknown }) {
      return db.transaction(async (tx) => {
        const row = await loadForNode(tx, id, input.secret, true);
        if (!row) return { ok: false as const, reason: "not_found" as const };
        if (row.status === "claimed")
          return { ok: false as const, reason: "already_claimed" as const };
        if (row.status !== "approved" || !row.account_id)
          return { ok: false as const, reason: "not_approved" as const };
        if (isExpired(row)) return { ok: false as const, reason: "expired" as const };
        const nonceValid =
          typeof input.nonce === "string" &&
          row.claim_nonce !== null &&
          equalHash(sha256(row.claim_nonce), sha256(input.nonce)) &&
          row.claim_nonce_expires_at !== null &&
          new Date(row.claim_nonce_expires_at).getTime() > clock();
        // The nonce is single-use whatever the outcome.
        await tx.query(
          "UPDATE pairings SET claim_nonce = NULL, claim_nonce_expires_at = NULL WHERE id = $1",
          [id],
        );
        if (
          !nonceValid ||
          !verifySignature(row.public_key, claimMessage(id, input.nonce as string), input.signature)
        ) {
          const failed = row.failed_claims + 1;
          await tx.query(
            "UPDATE pairings SET failed_claims = $2::int, status = CASE WHEN $2::int >= $3::int THEN 'rejected' ELSE status END WHERE id = $1",
            [id, failed, MAX_FAILED_CLAIMS],
          );
          return { ok: false as const, reason: "bad_proof" as const };
        }
        const deviceId = randomUUID();
        await tx.query(
          `INSERT INTO devices (id, account_id, installation_id, type, platform, display_name, capabilities, device_key_id, public_key, last_seen_at)
           VALUES ($1,$2,$3,'node',$4,$5,$6,$7,$8,$9)`,
          [
            deviceId,
            row.account_id,
            `node-${randomUUID()}`,
            row.platform,
            row.display_name,
            row.capabilities,
            row.key_id,
            row.public_key,
            now(),
          ],
        );
        await tx.query("UPDATE pairings SET status = 'claimed', device_id = $2 WHERE id = $1", [
          id,
          deviceId,
        ]);
        return { ok: true as const, deviceId, keyId: row.key_id };
      });
    },
  };
}
export type PairingService = ReturnType<typeof createPairingService>;
