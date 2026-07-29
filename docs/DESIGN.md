# Design

## Two engines, one page

**Popularity** (GitHub traffic API) applies only to repos with an audience.
**Activity** (commits, staleness) applies to everything. They are different
sources with different retention, joined only at the presentation layer.

## The 14-day wall

The traffic endpoints return **only the last 14 days**, daily granularity, and
require push access on the repo. Nothing backfills. Traffic history exists only
if something was collecting at the time — which is why the collector shipped
before the UI.

Commit history and star history are *not* subject to this:
- `stats/commit_activity` returns 52 weeks x 7 days in one call
- stargazers with the `star+json` media type carry `starred_at`

Both backfill about a year on first sync.

## Idempotent traffic writes

Each run re-reports the same 14 days. `traffic_daily` is keyed `(repo_id, day)`
and upserted with `GREATEST`, so:

- re-syncing cannot multiply counts
- a day GitHub revises downward cannot shrink stored history

## Snapshots vs series

`referrers_snapshot` and `paths_snapshot` hold **dated snapshots**, not a series.
Those endpoints return a rolling top-10 aggregate, so summing them across dates
is meaningless. They are keyed by `captured` and read one date at a time.

## Never sum uniques

GitHub reports uniques **per period**. Summing daily uniques counts a returning
actor once per day. The dashboard uses `max()` per day and labels it "peak/day".
See `docs/adr/0002`.

## Failure isolation

Every repo commits individually. One repo's 403 — a private repo the token can't
see, or a permissions gap — cannot roll back the other 28. `sync_runs` records
each run with row counts, API call count, and error text.
