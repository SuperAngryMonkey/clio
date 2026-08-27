-- GitHub secret-scanning alerts, mirrored not generated.
--
-- Clio does not scan for secrets. It cannot: the Worker never touches repo
-- content, and cloning 30+ repos to walk their history is far outside the
-- free tier's 10ms CPU and 50-subrequest budget. This table mirrors alerts
-- GitHub already raised, which is one cheap API read per repo.
--
-- Scanning is free only on PUBLIC repos; private repos need paid Secret
-- Protection. So a repo with no rows here has either had no alerts or has no
-- scanning enabled at all, and those two states are NOT the same thing --
-- scan_enabled on repos records which.
--
-- Deliberately stores no secret value. Location and fingerprint only: a
-- dashboard listing live credentials would itself become the thing worth
-- stealing.

CREATE TABLE IF NOT EXISTS secret_alerts (
  repo_id     INTEGER NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,           -- alert number, unique per repo
  state       TEXT    NOT NULL,           -- open | resolved
  resolution  TEXT,                       -- revoked | false_positive | used_in_tests | wont_fix | null
  secret_type TEXT,                       -- e.g. github_personal_access_token
  provider    TEXT,                       -- display name from GitHub
  validity    TEXT,                       -- active | inactive | unknown
  html_url    TEXT,
  created_at  TEXT,
  resolved_at TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, number)
);

CREATE INDEX IF NOT EXISTS idx_secret_alerts_state ON secret_alerts(state);

-- 1 = scanning on, 0 = off/unavailable, NULL = not yet determined.
ALTER TABLE repos ADD COLUMN scan_enabled INTEGER;
