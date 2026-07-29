# Operations

## Services

| Unit | Role |
|---|---|
| `clio-collector.timer` | daily 06:15 UTC, 15-min jitter, `Persistent=true` |
| `clio-collector.service` | oneshot sync |
| `clio-web.service` | gunicorn, 2 workers, :8080, restart on failure |

`Persistent=true` matters: a host down at 06:15 runs the sync on next boot
rather than skipping the day.

## Routine checks

```
systemctl list-timers clio-collector.timer
journalctl -u clio-collector -n 40 --no-pager
psql -d clio -c "SELECT id,finished,ok,repos_synced,api_calls,error FROM sync_runs ORDER BY id DESC LIMIT 5"
```

`sync_runs.ok = false` with error text is the first place to look. `/healthz`
is unauthenticated for external monitoring.

## Expected shape

~29 repos, ~150 API calls, under a minute. Rate limit is 5,000/hour
authenticated, so the collector uses about 3% of budget per day.

## Failure modes

| Symptom | Cause |
|---|---|
| `no GITHUB_TOKEN set` | `.env` missing or still placeholder |
| widespread HTTP 403 | token lacks Administration:read, or org approval pending |
| `UnicodeEncodeError` on insert | cluster is SQL_ASCII — see adr/0001 |
| collector silently stops running | PAT expired; fine-grained tokens do expire |

The last one is the trap. Nothing alerts on it — the timer keeps firing and the
sync keeps failing. Check `sync_runs` after any token rotation.

## Rotating the dashboard password

```
python3 -c "
from werkzeug.security import generate_password_hash as h
import getpass, os
p = getpass.getpass('New password: ')
open('/opt/clio/webauth','w').write('ghost:'+h(p)); os.chmod('/opt/clio/webauth',0o600)"
chown clio:clio /opt/clio/webauth
```

Takes effect immediately; the app reads the file per request. No restart needed.
