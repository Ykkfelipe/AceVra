import { randomUUID } from "node:crypto";
import type { AccountRecord, AdmissionDecision, ClerkUserDirectory, SqlExecutor } from "./ports.js";

interface AdmissionRow {
  id: string;
  clerk_user_id: string | null;
  email: string | null;
  status: "approved" | "revoked";
}
interface AccountRow {
  id: string;
  clerk_user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: Date | string;
}

const toAccount = (row: AccountRow): AccountRecord => ({
  id: row.id,
  clerkUserId: row.clerk_user_id,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
  createdAt: new Date(row.created_at).toISOString(),
});
const decide = (status: AdmissionRow["status"]): AdmissionDecision =>
  status === "approved" ? { admitted: true } : { admitted: false, reason: "revoked" };

/** Operator-owned approval ledger. Revoke always wins over approve. */
export function createAdmissionLedger(db: SqlExecutor) {
  return {
    async approve(target: { clerkUserId?: string; email?: string }) {
      const email = target.email?.trim().toLowerCase() || null;
      const clerkUserId = target.clerkUserId?.trim() || null;
      if (!email && !clerkUserId) throw new Error("approve requires an email or Clerk user id");
      // An already-revoked row stays revoked: re-admission is an explicit un-revoke.
      await db.query(
        `INSERT INTO admissions (id, clerk_user_id, email, status, approved_at)
         VALUES ($1, $2, $3, 'approved', now())
         ON CONFLICT DO NOTHING`,
        [randomUUID(), clerkUserId, email],
      );
    },
    async unrevoke(target: { clerkUserId?: string; email?: string }) {
      await db.query(
        `UPDATE admissions SET status = 'approved', revoked_at = NULL, approved_at = now()
         WHERE (clerk_user_id = $1 AND $1 IS NOT NULL) OR (email = $2 AND $2 IS NOT NULL)`,
        [target.clerkUserId ?? null, target.email?.trim().toLowerCase() ?? null],
      );
    },
    async revoke(target: { clerkUserId?: string; email?: string }) {
      const email = target.email?.trim().toLowerCase() || null;
      const clerkUserId = target.clerkUserId?.trim() || null;
      if (!email && !clerkUserId) throw new Error("revoke requires an email or Clerk user id");
      const updated = await db.query(
        `UPDATE admissions SET status = 'revoked', revoked_at = now()
         WHERE (clerk_user_id = $1 AND $1 IS NOT NULL) OR (email = $2 AND $2 IS NOT NULL)
         RETURNING id`,
        [clerkUserId, email],
      );
      if (updated.rows.length === 0) {
        await db.query(
          `INSERT INTO admissions (id, clerk_user_id, email, status, revoked_at)
           VALUES ($1, $2, $3, 'revoked', now())`,
          [randomUUID(), clerkUserId, email],
        );
      }
    },
  };
}

export type AdmissionLedger = ReturnType<typeof createAdmissionLedger>;

/**
 * Admission + account resolution for one authenticated Clerk user. Admission is
 * read from the backend ledger on every call so revocation takes effect at once.
 */
export function createAccountService(deps: { db: SqlExecutor; directory: ClerkUserDirectory }) {
  return {
    async resolve(
      clerkUserId: string,
    ): Promise<
      { decision: { admitted: true }; account: AccountRecord } | { decision: AdmissionDecision }
    > {
      const existing = await deps.db.query<AdmissionRow>(
        "SELECT id, clerk_user_id, email, status FROM admissions WHERE clerk_user_id = $1",
        [clerkUserId],
      );
      let decision: AdmissionDecision;
      let profile: Awaited<ReturnType<ClerkUserDirectory["getUser"]>> | null = null;
      if (existing.rows[0]) {
        decision = decide(existing.rows[0].status);
      } else {
        // First sight of this Clerk user: bind a pending email approval through the
        // user's VERIFIED emails as reported by Clerk's backend, never by client claim.
        profile = await deps.directory.getUser(clerkUserId);
        decision = await bindByVerifiedEmail(deps.db, clerkUserId, profile.verifiedEmails);
      }
      if (!decision.admitted) return { decision };

      const known = await deps.db.query<AccountRow>(
        "SELECT * FROM accounts WHERE clerk_user_id = $1",
        [clerkUserId],
      );
      if (known.rows[0]) return { decision, account: toAccount(known.rows[0]) };
      profile ??= await deps.directory.getUser(clerkUserId);
      const created = await deps.db.query<AccountRow>(
        `INSERT INTO accounts (id, clerk_user_id, display_name, avatar_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (clerk_user_id) DO UPDATE SET updated_at = now()
         RETURNING *`,
        [randomUUID(), clerkUserId, profile.displayName, profile.avatarUrl],
      );
      return { decision, account: toAccount(created.rows[0]!) };
    },
  };
}

async function bindByVerifiedEmail(
  db: SqlExecutor,
  clerkUserId: string,
  verifiedEmails: string[],
): Promise<AdmissionDecision> {
  if (verifiedEmails.length === 0) return { admitted: false, reason: "not_approved" };
  return db.transaction(async (tx) => {
    const rows = await tx.query<AdmissionRow>(
      `SELECT id, clerk_user_id, email, status FROM admissions
       WHERE clerk_user_id IS NULL AND email = ANY($1::text[])
       ORDER BY (status = 'revoked') DESC LIMIT 1`,
      [verifiedEmails],
    );
    const row = rows.rows[0];
    if (!row) return { admitted: false, reason: "not_approved" } as const;
    await tx.query("UPDATE admissions SET clerk_user_id = $1 WHERE id = $2", [clerkUserId, row.id]);
    return decide(row.status);
  });
}
