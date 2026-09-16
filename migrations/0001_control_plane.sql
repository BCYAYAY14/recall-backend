-- D1 "recall-meta": the control plane (plan 5.1). Small, cold, exportable.
-- Document content NEVER lives here; it is in LibraryDO.
-- Every token, code and share token is stored as a sha256 hex, never itself.

CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  claimed_at    TEXT
);

CREATE TABLE library (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES account(id),
  created_at     TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  delete_requested_at TEXT
);

CREATE TABLE device (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES account(id),
  library_id      TEXT NOT NULL REFERENCES library(id),
  label           TEXT NOT NULL,
  platform        TEXT NOT NULL,
  scope           TEXT NOT NULL,
  token_sha       TEXT NOT NULL,
  token_version   INTEGER NOT NULL DEFAULT 1,
  prev_token_sha  TEXT,
  prev_valid_until TEXT,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT,
  app_version     TEXT,
  protocol        INTEGER,
  revoked_at      TEXT
);
CREATE UNIQUE INDEX idx_device_token ON device(token_sha);
CREATE INDEX idx_device_prev_token ON device(prev_token_sha);

CREATE TABLE pairing_code (
  code_sha      TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  issued_by     TEXT NOT NULL REFERENCES device(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  used_at       TEXT
);

CREATE TABLE recovery_code (
  code_sha      TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  used_at       TEXT
);

CREATE TABLE share (
  id             TEXT PRIMARY KEY,
  library_id     TEXT NOT NULL REFERENCES library(id),
  notebook_id    TEXT NOT NULL,
  token_sha      TEXT NOT NULL UNIQUE,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  revoked_at     TEXT,
  last_viewed_at TEXT,
  view_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE attachment (
  sha           TEXT NOT NULL,
  library_id    TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  mime          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  refcount      INTEGER NOT NULL DEFAULT 0,
  orphan_at     TEXT,
  upload_id     TEXT,
  upload_at     TEXT,
  PRIMARY KEY (library_id, sha)
);

CREATE TABLE attachment_part (
  library_id    TEXT NOT NULL,
  sha           TEXT NOT NULL,
  n             INTEGER NOT NULL,
  etag          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  PRIMARY KEY (library_id, sha, n)
);

-- Counts and timings only. No note text, token, key, path or label (plan 16.1).
CREATE TABLE sync_run (
  id            TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  transport     TEXT NOT NULL,
  ops_in        INTEGER NOT NULL DEFAULT 0,
  ops_out       INTEGER NOT NULL DEFAULT 0,
  stale         INTEGER NOT NULL DEFAULT 0,
  conflicts     INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0,
  bytes_in      INTEGER NOT NULL DEFAULT 0,
  bytes_out     INTEGER NOT NULL DEFAULT 0,
  outcome       TEXT
);
CREATE INDEX idx_sync_run_started ON sync_run(started_at);

-- protocol_min, protocol_max, schema_version, pair_salt, claim_failures:<version>,
-- claim_code_sha
CREATE TABLE deploy_meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
