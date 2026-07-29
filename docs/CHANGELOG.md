# Changelog

## 0.1.0 — 2026-07-29

First working version.

### Added
- Collector: repos, daily metrics, traffic, referrers, paths, star history,
  commit history. Stdlib HTTP + psycopg2, no dependency tree.
- Postgres schema, 8 tables, idempotent traffic upserts.
- Flask dashboard with Basic Auth: metric tiles, HOT, REFERRERS,
  MOST ACTIVE, GOING COLD.
- systemd collector timer (daily, jittered, persistent) and gunicorn web unit.
- `install.sh` — reproducible build on fresh Debian 12.

### Fixed
- Postgres cluster forced to C.UTF-8. The default SQL_ASCII cluster raised
  `UnicodeEncodeError` on any non-ASCII repo description and aborted the sync
  partway through the fleet. See `adr/0001`.

### Notes
- Dashboard reports peak-per-day uniques, never summed. See `adr/0002`.
- No tailnet identifiers in tracked files; footer host comes from `.env`.
