-- Clio schema, SQLite/D1. Ported from the Postgres schema on main.
-- Type mapping: BIGINT->INTEGER, BOOLEAN->INTEGER 0/1, TIMESTAMPTZ/DATE->TEXT.
-- GREATEST(a,b) becomes the two-argument scalar MAX(a,b).

CREATE TABLE IF NOT EXISTS repos (
  repo_id     INTEGER PRIMARY KEY,
  full_name   TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  private     INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  fork        INTEGER NOT NULL DEFAULT 0,
  language    TEXT,
  description TEXT,
  html_url    TEXT,
  created_at  TEXT,
  pushed_at   TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced TEXT
);

CREATE TABLE IF NOT EXISTS repo_metrics_daily (
  repo_id INTEGER NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  day     TEXT    NOT NULL,
  stars INTEGER, forks INTEGER, watchers INTEGER, open_issues INTEGER, size_kb INTEGER,
  PRIMARY KEY (repo_id, day)
);

CREATE TABLE IF NOT EXISTS traffic_daily (
  repo_id       INTEGER NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  day           TEXT    NOT NULL,
  views         INTEGER NOT NULL DEFAULT 0,
  views_unique  INTEGER NOT NULL DEFAULT 0,
  clones        INTEGER NOT NULL DEFAULT 0,
  clones_unique INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, day)
);

CREATE TABLE IF NOT EXISTS referrers_snapshot (
  repo_id  INTEGER NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  captured TEXT    NOT NULL,
  referrer TEXT    NOT NULL,
  count INTEGER, uniques INTEGER,
  PRIMARY KEY (repo_id, captured, referrer)
);

CREATE TABLE IF NOT EXISTS paths_snapshot (
  repo_id  INTEGER NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  captured TEXT    NOT NULL,
  path     TEXT    NOT NULL,
  title TEXT, count INTEGER, uniques INTEGER,
  PRIMARY KEY (repo_id, captured, path)
);

CREATE TABLE IF NOT EXISTS stars (
  repo_id    INTEGER NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  user_login TEXT    NOT NULL,
  starred_at TEXT    NOT NULL,
  PRIMARY KEY (repo_id, user_login)
);

CREATE TABLE IF NOT EXISTS commits_daily (
  repo_id INTEGER NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  day     TEXT    NOT NULL,
  commits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, day)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started  TEXT NOT NULL DEFAULT (datetime('now')),
  finished TEXT,
  ok INTEGER, repos_synced INTEGER, api_calls INTEGER, error TEXT,
  slice_from INTEGER, slice_to INTEGER
);

-- Cursor for chunked collection; persists between cron invocations, which is
-- what makes the free-tier subrequest cap survivable.
CREATE TABLE IF NOT EXISTS sync_state (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE INDEX IF NOT EXISTS traffic_day_idx   ON traffic_daily(day);
CREATE INDEX IF NOT EXISTS commits_day_idx   ON commits_daily(day);
CREATE INDEX IF NOT EXISTS stars_at_idx      ON stars(starred_at);
CREATE INDEX IF NOT EXISTS repos_private_idx ON repos(private);
