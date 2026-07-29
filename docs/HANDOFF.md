# Handoff

## State

Collector and dashboard both running on an LXC target. Daily sync verified end
to end: 29 repos, ~150 API calls, under a minute, no errors.

## What the data says so far

Referrers are entirely `github.com` with `uniques = 1`, and the top paths are
`/pulse` and `/graphs/traffic` — GitHub's own insights pages. The *views* are
the operator checking his own repos. There is no external discovery, and stars
and forks are zero fleet-wide.

Clones are a different signal: double-digit counts on several repos with
near-zero views, including one with 12 clones and no views at all. That is the
signature of automated mirroring or CI, not readers.

The activity panel is the one currently earning its keep — commit volume and
staleness across all 29, including several repos idle 70+ days.

## Open threads

- **`cloudflare` branch is scaffolding only.** Port needs: Postgres -> D1
  (SQLite), systemd -> Cron Triggers, and the collector split across multiple
  invocations to stay under the free-plan cap of 50 external subrequests. ~150
  calls per full sync means roughly 4 chunks with a cursor in D1.
- **"What's hot" is unresolved.** Ranking by raw views just ranks by age. The
  intent is momentum against a trailing baseline. Deferred: at single-digit
  weekly views there is no baseline to compute against yet.
- **Weekly digest.** A dashboard nobody opens is worth less than a push. The
  going-cold panel in particular suits an emailed digest.
- **Bind address** is `0.0.0.0`; consider narrowing.

## Gotchas that cost time

1. Postgres on minimal Debian initialises **SQL_ASCII**. One Unicode arrow in a
   repo description killed the first build. Force the locale at cluster creation.
2. Deleting a container does **not** release its Tailscale node. The name stays
   claimed and the replacement joins as `-1`. Delete the node first.
3. Never `SUM(uniques)`.
