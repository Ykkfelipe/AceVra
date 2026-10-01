-- M2C: node pairing + device key. Pairings are short-lived and hold only HASHES of the
-- bearer secret and the human code. The node's PUBLIC key binds to one devices row.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS public_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS devices_key_id_idx ON devices (device_key_id) WHERE device_key_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pairings (
  id                TEXT PRIMARY KEY,
  secret_hash       TEXT NOT NULL,
  code_hash         TEXT NOT NULL,
  public_key        TEXT NOT NULL,
  key_id            TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  platform          TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux')),
  capabilities      TEXT[] NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'claimed')),
  account_id        TEXT REFERENCES accounts(id),
  device_id         TEXT REFERENCES devices(id),
  claim_nonce       TEXT,
  claim_nonce_expires_at TIMESTAMPTZ,
  failed_claims     INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  approved_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pairings_code_idx ON pairings (code_hash);
