-- Package download telemetry, alongside GitHub traffic.
--
-- Clio was built when nothing was published. Clones turned out to be mirroring
-- noise; installs are the harder signal. Same shape as traffic_daily so the
-- existing chart code works unchanged: keyed (name, day), upserted with MAX so
-- re-reading an overlapping window is idempotent.

CREATE TABLE IF NOT EXISTS packages (
  name      TEXT PRIMARY KEY,
  registry  TEXT NOT NULL DEFAULT 'pypi',
  repo_id   INTEGER REFERENCES repos(repo_id) ON DELETE SET NULL,
  first_seen TEXT NOT NULL DEFAULT (date('now'))
);

CREATE TABLE IF NOT EXISTS package_downloads_daily (
  name      TEXT    NOT NULL REFERENCES packages(name) ON DELETE CASCADE,
  day       TEXT    NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,  -- non-mirror: the number that means something
  mirrors   INTEGER NOT NULL DEFAULT 0,  -- with_mirrors total, kept for the ratio
  PRIMARY KEY (name, day)
);

CREATE INDEX IF NOT EXISTS idx_pkg_dl_day ON package_downloads_daily(day);
