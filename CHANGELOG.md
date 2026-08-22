# Changelog

## Package downloads, collector alerting, light theme (2026-08-22)

**Package downloads.** Migration 0002 adds `packages` and
`package_downloads_daily`, keyed `(name, day)` and upserted with MAX like
`traffic_daily`, so re-reading an overlapping window stays idempotent. The
collector fetches pypistats after the repo slice, so repos keep first claim on
the free plan's subrequest budget; one call per package returns the full daily
history. A fourth chart panel and a PACKAGES table appear only when
`PYPI_PACKAGES` names something, and `/api/series` now returns downloads
alongside traffic.

The point is calibration, not vanity. Clones are largely mirrors, CI and
scanners; downloads are a harder signal, and putting both on one time axis
against the commit bars makes it obvious which is which.

**Collector alerting.** A silent collector was the worst failure available
here, because Clio holds days GitHub has already deleted and a gap cannot be
backfilled. Two checks: no successful sync within `STALE_RUN_HOURS` or three
consecutive failures, and — separately — any repo uncollected for
`STALE_REPO_DAYS`. The second exists because chunked collection means the
cursor can stick on part of the fleet while everything else updates, starving
one repo without the dashboard looking wrong.

`/healthz` now reports collector state and returns 503 when unhealthy, exposing
only ok, last sync and a problem count since it sits ahead of Access. Alerts
POST plain text to `ALERT_WEBHOOK`, suppressed for `ALERT_MIN_HOURS` between
repeats. Empty webhook disables alerting; the dashboard banner appears only
when something is wrong.

**Light theme.** All colours now derive from one set of custom properties with
a `[data-theme=light]` override, including the SVG charts — inline SVG inherits
the document's variables, so the panels follow the theme rather than leaving
neon lines on a white page. Light chart hues are re-picked rather than reused.
Theme resolves before first paint, follows `prefers-color-scheme` when unset,
and the header toggle persists an override.

**Docs.** README gains a Configuration section covering every variable, and a
"Why not just use the Insights tab" section: GitHub discards traffic after 14
days with no export, and clone counts mostly are not people.

## Time series (2026-08-03)

Added, cloudflare branch:
- GET /api/series?days=N[&repo=NAME] returns the daily series as JSON. Fleet
  scope aggregates; repo scope returns that repo's rows. Uniques are per-day
  and are never summed (ADR-0002); fleet scope reports peak-per-day.
- ACTIVITY section on the dashboard: 90-day inline SVG of daily clones (area +
  line), views (dashed) and commits (bars, independent scale).
- Per-repo clone sparklines in the HOT table, 30-day window.

No schema change. traffic_daily, commits_daily and repo_metrics_daily were
already keyed (repo_id, day); only the presentation layer was summing them
away. Missing days render as gaps rather than zeros, because at REPOS_PER_RUN
per 3h a full fleet cycle takes about 1.5 days and early per-repo rows are
unevenly dense. A day present with value 0 is a real zero and is drawn.

