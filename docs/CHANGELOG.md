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

## 0.2.0 — 2026-07-29 (cloudflare branch)

Full port to Cloudflare. The LXC deployment on `main` is superseded.

### Added
- Worker handling both collection (`scheduled`) and the dashboard (`fetch`).
- D1 schema, migration `0001_init`.
- Chunked collection with a cursor in `sync_state`, and a `Budget` guard on
  external subrequests. See `adr/0003`.
- Cloudflare Access as the authentication boundary, with `REQUIRE_ACCESS`
  defaulting to on so the Worker fails closed. See `adr/0004`.
- Authenticated `GET /sync` and a footer link to advance one slice manually.
- `docs/SETUP-CLOUDFLARE.md` — build from nothing, including both Cloudflare traps.
- `tools/zt-warp-flag.sh`, `tools/cf-redirect-scope.sh`.

### Changed
- Schema ported to SQLite: `BIGINT`→`INTEGER`, booleans as 0/1, dates as TEXT,
  `GREATEST(a,b)`→ two-argument `MAX(a,b)`. Traffic upserts stay idempotent.
- D1 writes batched per repo rather than statement by statement.
- `REPOS_PER_RUN` 8 → 7, for subrequest headroom.

### Fixed
- `stats/commit_activity` returns 202 while GitHub computes it. Skipping outright
  left MOST ACTIVE empty for days; one retry after 3s resolves it, since the first
  request is what triggers the computation.
