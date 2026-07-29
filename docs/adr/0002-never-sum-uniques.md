# ADR 0002 — Report peak-per-day uniques, never a sum

**Status:** accepted, 2026-07-29

## Context

`traffic_daily` stores `views_unique` and `clones_unique` per day, because the
API reports per day. The obvious dashboard query is
`SUM(clones_unique)` over the window.

That number is wrong in a way that flatters. GitHub computes uniqueness **within
a period**. A single CI job cloning nightly for 14 days contributes 1 unique per
day, which sums to 14 — indistinguishable from 14 separate people cloning once.

For a fleet whose clone traffic is mostly automation, this is not a rounding
error. It is the difference between "25 people are interested" and "one mirror
has a cron job."

## Decision

The dashboard reports `MAX(unique)` across the window, labelled **peak/day**,
with a visible footnote. `SUM()` is applied to `views` and `clones` — raw counts
*are* additive — but never to uniques.

## Alternatives rejected

**Sum with a caveat in the docs.** Nobody reads the docs while looking at a
number. The metric has to be honest on its face.

**Distinct actors over the window.** Genuinely what we want, and impossible: the
API returns aggregates, never identities.

## Consequences

Peak/day understates true distinct actors when different people clone on
different days. That bias is acceptable: it errs toward "less popular than you
hoped," which is the safer direction for a vanity metric.
