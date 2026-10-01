-- M2A: Account + private-alpha admission only. Future entities (devices,
-- conversations, tasks) are intentionally absent.
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backend-owned approval ledger. A row targets a Clerk user id, or a (lowercased)
-- email that binds to a Clerk user on first sign-in via that user's VERIFIED email.
CREATE TABLE IF NOT EXISTS admissions (
  id            TEXT PRIMARY KEY,
  clerk_user_id TEXT UNIQUE,
  email         TEXT UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('approved', 'revoked')),
  approved_at   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (clerk_user_id IS NOT NULL OR email IS NOT NULL)
);
