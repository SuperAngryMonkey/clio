# Changelog

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

