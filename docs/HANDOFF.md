# Handoff &mdash; Cloudflare

## State

Live at a Worker custom domain behind Cloudflare Access. D1 populated by a cron
collector every 3 hours. First successful slice: 8 repos, 41 API calls.

The LXC deployment on `main` is superseded and its container is due for
decommissioning.

## What the data says

Referrers are entirely `github.com` with `uniques = 1`, and the top paths are
`/pulse` and `/graphs/traffic` — GitHub's own insights pages. The *views* are the
operator looking at his own repos. Stars and forks are zero across the fleet.

Clones are a different signal: double-digit counts on several repos against
near-zero views, including one with 12 clones and no views at all. That is the
signature of automated mirroring or CI, not readers.

So the honest answer to "are my repos popular" is no — but "something is pulling
copies of them on a schedule" is a more interesting finding than the question
anticipated. Confirming which requires referrer data accumulating over time.

## Open threads

- **"What's hot" is unresolved.** Ranking by raw views ranks by age. The intent is
  momentum against a trailing baseline. Deferred: at single-digit weekly views
  there is no baseline to compute against.
- **JWT signature validation** instead of header presence. See `adr/0004`.
- **`/healthz` is gated** by Access; needs a bypass policy to be monitorable.
- **No alerting on failed cron runs.** `sync_runs` records them but nothing
  surfaces them. A weekly digest, or a scheduled check that pushes on `ok=0`.
- **Commit history fills over two cycles**, not one, even with the 202 retry.

## Gotchas that cost time

1. **A zone-wide redirect rule pre-empts Worker routes.** Redirect rules run
   earlier in the pipeline, so the Worker never executes. `server: cloudflare` on
   an unexpected 302 is the tell. Narrow to `http.host eq "apex"`.
2. **`allow_authenticate_via_warp` blocks Access application saves** when
   `warp_auth_session_duration` is null on the organization. The error names the
   field; set it rather than hunting for a toggle.
3. **Cloudflare org-level PUTs replace rather than patch.** Sending one field
   blanked `auth_domain` and was rejected — luckily, since success would have
   broken the team domain.
4. **Stats endpoints 202 on first request.** The request itself triggers the
   computation.
5. **Never `SUM(uniques)`.** See `adr/0002` on `main`.
