-- Surge schema.

-- A run ticket. The seed is issued here so the server can replay the submitted
-- move log and derive the score itself. `status` makes a ticket single-use.
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  seed        INTEGER NOT NULL,
  ip          TEXT,
  created_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS idx_runs_ip_created ON runs (ip, created_at);

-- Verified scores. Every row here was produced by replaying a real move log.
CREATE TABLE IF NOT EXISTS scores (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs (id),
  name         TEXT NOT NULL,
  score        INTEGER NOT NULL,
  level        INTEGER NOT NULL DEFAULT 0,
  best_tile    INTEGER NOT NULL DEFAULT 0,
  merges       INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- The leaderboard read is this exact ordering.
CREATE INDEX IF NOT EXISTS idx_scores_board ON scores (score DESC, best_tile DESC, created_at ASC);

-- One row per banner claim attempt.
--   pending  — order created, money not yet taken
--   live     — paid and currently displayed (at most one)
--   retired  — was live, then outbid
--   outbid   — paid, but someone else took the slot first
CREATE TABLE IF NOT EXISTS banner_claims (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE,
  capture_id    TEXT,
  text          TEXT NOT NULL,
  url           TEXT NOT NULL,
  name          TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  claimed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_banner_live ON banner_claims (status, amount_cents DESC);
