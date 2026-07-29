-- Clio schema (PostgreSQL).
-- Design notes:
--  * traffic_daily is keyed (repo_id, day) and upserted with GREATEST. GitHub's
--    traffic API returns a rolling 14-day window, so the same day is re-reported
--    on every sync; GREATEST makes re-syncs idempotent and non-destructive.
--  * referrers/paths are DATED SNAPSHOTS, not a cumulative series. Those endpoints
--    return a top-10 rolling aggregate, so they cannot be summed over time.
--  * uniques must never be SUMmed across days. See docs/adr/0002.

CREATE TABLE IF NOT EXISTS repos (
  repo_id     BIGINT PRIMARY KEY,
  full_name   TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  private     BOOLEAN NOT NULL,
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  fork        BOOLEAN NOT NULL DEFAULT FALSE,
  language    TEXT,
  description TEXT,
  html_url    TEXT,
  created_at  TIMESTAMPTZ,
  pushed_at   TIMESTAMPTZ,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS repo_metrics_daily (
  repo_id BIGINT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  day     DATE   NOT NULL,
  stars INT, forks INT, watchers INT, open_issues INT, size_kb INT,
  PRIMARY KEY (repo_id, day)
);

CREATE TABLE IF NOT EXISTS traffic_daily (
  repo_id       BIGINT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  day           DATE   NOT NULL,
  views         INT NOT NULL DEFAULT 0,
  views_unique  INT NOT NULL DEFAULT 0,
  clones        INT NOT NULL DEFAULT 0,
  clones_unique INT NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, day)
);

CREATE TABLE IF NOT EXISTS referrers_snapshot (
  repo_id  BIGINT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  captured DATE   NOT NULL,
  referrer TEXT   NOT NULL,
  count INT, uniques INT,
  PRIMARY KEY (repo_id, captured, referrer)
);

CREATE TABLE IF NOT EXISTS paths_snapshot (
  repo_id  BIGINT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  captured DATE   NOT NULL,
  path     TEXT   NOT NULL,
  title TEXT, count INT, uniques INT,
  PRIMARY KEY (repo_id, captured, path)
);

CREATE TABLE IF NOT EXISTS stars (
  repo_id    BIGINT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  user_login TEXT   NOT NULL,
  starred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repo_id, user_login)
);

CREATE TABLE IF NOT EXISTS commits_daily (
  repo_id BIGINT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  day     DATE   NOT NULL,
  commits INT NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, day)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  started  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished TIMESTAMPTZ,
  ok BOOLEAN, repos_synced INT, api_calls INT, error TEXT
);

CREATE INDEX IF NOT EXISTS traffic_day_idx   ON traffic_daily(day);
CREATE INDEX IF NOT EXISTS commits_day_idx   ON commits_daily(day);
CREATE INDEX IF NOT EXISTS stars_at_idx      ON stars(starred_at);
CREATE INDEX IF NOT EXISTS repos_private_idx ON repos(private);
