-- M2D: server-owned task queue + ordered task events. Raw output lives only in task_events
-- (bounded); the task row stays small.
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  target_device_id    TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  -- Reserved for future agents/subagents; unused in M2D.
  initiating_agent_id TEXT,
  parent_task_id      TEXT REFERENCES tasks(id),
  type                TEXT NOT NULL CHECK (type IN ('process')),
  state               TEXT NOT NULL CHECK (state IN
    ('queued','dispatching','running','running_unknown','cancelling','completed','failed','cancelled')),
  spec                JSONB NOT NULL,
  idempotency_key     TEXT,
  attempt             INTEGER NOT NULL DEFAULT 0,
  result              JSONB,
  output_bytes        INTEGER NOT NULL DEFAULT 0,
  next_seq            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at         TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, target_device_id) REFERENCES devices (account_id, id),
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS tasks_target_state_idx ON tasks (target_device_id, state);
CREATE INDEX IF NOT EXISTS tasks_account_created_idx ON tasks (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  sequence   INTEGER NOT NULL,
  type       TEXT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload    JSONB NOT NULL DEFAULT '{}',
  -- Node-side sequence; the partial unique index makes node re-sends idempotent.
  source_seq INTEGER,
  PRIMARY KEY (task_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_events_source_idx ON task_events (task_id, source_seq) WHERE source_seq IS NOT NULL;
