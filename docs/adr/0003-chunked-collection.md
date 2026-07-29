# ADR 0003 — Collect a slice per invocation, not the whole fleet

**Status:** accepted, 2026-07-29 (Cloudflare branch)

## Context

A full sync of 29 repos costs ~150 GitHub API calls: one repo list, then five per
repo (views, clones, referrers, paths, commit activity), plus stargazers where a
repo has any.

Workers on the free plan are limited to **50 external subrequests per
invocation**. Paid plans get 10,000, configurable to 10 million. So a full sync
cannot happen in one invocation on the free plan, at any slice size.

## Decision

Each invocation collects a slice of the fleet and stores its position in a
`sync_state` table. The cron fires every 3 hours; at 7 repos per run, 29 repos
cycle in about 15 hours.

A `Budget` class caps external calls at 45 — below the 50 ceiling — and every call
goes through it. Exhaustion degrades to missing data on the last repo of a slice
rather than a failed invocation.

The 3-hour interval is also deliberate: a cron interval **over one hour** grants
the longer duration budget rather than the 30-second one.

## Alternatives rejected

**Paid plan.** $5/month removes the constraint entirely and is the honest answer
if this ever needs to be simple. The brief was free tier.

**Multiple cron triggers, each handling a fixed range.** Five triggers on the free
plan is enough, and it removes the cursor. But it hardcodes fleet size — adding
repos silently drops them from collection.

**Sub-Worker fan-out.** A dispatcher calling several Workers, each handling a
slice. Subrequests to Cloudflare services have a separate 1,000 limit, so this
works. Rejected as considerably more machinery than a cursor.

## Consequences

Any given repo's traffic is refreshed a bit more than once a day, not on every
run. This is harmless: the traffic API returns a rolling 14-day window, so a repo
visited tomorrow still reports the same fortnight. Nothing is lost between visits.

A cold start populates gradually, which reads as a bug — the dashboard shows a
subset of the fleet and panels look sparse. Mitigated with a manual **sync next
slice now** trigger in the footer, so a fresh deployment can be filled by clicking
rather than waiting out four cron intervals.

Fleet growth extends the cycle rather than breaking anything: 60 repos would take
~30 hours. Past that, raise the cron frequency before the slice size.
