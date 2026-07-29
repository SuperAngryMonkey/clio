# Operations &mdash; Cloudflare

## Moving parts

| Thing | Detail |
|---|---|
| Cron | `0 */3 * * *` — eight runs a day |
| Slice size | `REPOS_PER_RUN` var, currently 7 |
| Cursor | `sync_state` table, key `cursor` |
| Full cycle | ceil(fleet / slice) runs — ~15h for 29 repos |
| Run log | `sync_runs`, one row per invocation |

## Checking health

```
npx wrangler d1 execute clio --remote \
  --command "SELECT id,finished,ok,repos_synced,api_calls,slice_from,slice_to,error \
             FROM sync_runs ORDER BY id DESC LIMIT 5"
```

A healthy slice: `ok=1`, `repos_synced` equal to the slice size, `api_calls` in
the low 40s. `api_calls` at the 45 guard means the budget was exhausted and some
repos were only partly collected — lower `REPOS_PER_RUN`.

Live logs:

```
npx wrangler tail
```

## Forcing a sync

The dashboard footer link, or:

```
curl -X POST https://<hostname>/sync   # requires an Access session
```

Both advance the cursor by one slice.

## Failure modes

| Symptom | Cause |
|---|---|
| `ok=0`, error mentions 401 | `GITHUB_TOKEN` secret missing or the PAT expired |
| `ok=0`, repo list failed | token lacks Metadata:read, or org approval pending |
| Widespread HTTP 403 in a slice | token lacks Administration:read |
| MOST ACTIVE empty | `stats/commit_activity` still 202ing; fills next cycle |
| `api_calls` pinned at 45 | slice too large for the subrequest budget |
| Hostname 302s somewhere unexpected | a zone redirect rule is pre-empting the Worker |
| No sync runs at all | cron not registered; re-deploy and check the trigger output |

**Cron Triggers do not retry and do not alert.** A failed run is gone until the
next tick, and nothing tells you. `sync_runs` is the only record. This is a real
regression from systemd's `Persistent=true` on the LXC deployment — the
mitigating factor is that the traffic API re-reports a rolling 14-day window, so
a missed run self-heals on the next pass rather than losing data.

**PAT expiry is silent.** The timer keeps firing and every sync fails. Check
`sync_runs` after any token rotation, and record the expiry date somewhere visible.

## Free-plan ceilings

| Limit | Value | Headroom |
|---|---|---|
| External subrequests / invocation | 50 | guard at 45, uses ~43 |
| Requests / day | 100,000 | eight cron runs plus browsing |
| D1 rows written / day | 100,000 | a few hundred |
| Cron triggers | 5 per account | 1 used |

The subrequest cap is the only one that constrains the design. See `adr/0003`.
