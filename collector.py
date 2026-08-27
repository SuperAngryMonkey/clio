#!/usr/bin/env python3
"""Clio collector - GitHub popularity + activity -> Postgres.

Runs once per invocation and exits; scheduling is systemd's job (see
systemd/clio-collector.timer). Every repo is committed individually so one
repo's 403 cannot roll back the rest of the fleet.
"""
import os, sys, time, json, datetime as dt
import urllib.request, urllib.error, urllib.parse
import psycopg2

ENV_PATH = "/opt/clio/.env"
API = "https://api.github.com"
CALLS = 0

def load_env(path):
    if not os.path.exists(path): return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env(ENV_PATH)
TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
OWNER = os.environ.get("GITHUB_OWNER", "").strip()
if not TOKEN or TOKEN.startswith("PUT_"):
    sys.exit("clio: no GITHUB_TOKEN set in " + ENV_PATH)

def api(path, accept="application/vnd.github+json", params=None):
    """GET with retry. Returns (parsed, error). 202 means stats are still
    being computed server-side, so back off and retry rather than fail."""
    global CALLS
    url = path if path.startswith("http") else API + path
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for attempt in range(4):
        req = urllib.request.Request(url)
        req.add_header("Authorization", "Bearer " + TOKEN)
        req.add_header("Accept", accept)
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        req.add_header("User-Agent", "clio-collector")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                CALLS += 1
                body = r.read()
                if r.status == 202:
                    time.sleep(4); continue
                rem = r.headers.get("X-RateLimit-Remaining")
                if rem and rem.isdigit() and int(rem) < 50:
                    time.sleep(2)
                return (json.loads(body.decode("utf-8")) if body else None), None
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and attempt < 3:
                time.sleep(5 * (attempt + 1)); continue
            return None, "HTTP %s" % e.code
        except Exception as e:
            if attempt < 3:
                time.sleep(2); continue
            return None, str(e)
    return None, "retries exhausted"

def paged(path, accept="application/vnd.github+json", params=None, cap=20):
    out, page = [], 1
    while page <= cap:
        p = dict(params or {}); p.update({"per_page": 100, "page": page})
        data, err = api(path, accept, p)
        if err or not data: break
        out.extend(data)
        if len(data) < 100: break
        page += 1
    return out

def main():
    conn = psycopg2.connect(os.environ.get("CLIO_DSN", "dbname=clio"))
    conn.set_client_encoding("UTF8")
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("INSERT INTO sync_runs (started) VALUES (now()) RETURNING id")
    run_id = cur.fetchone()[0]; conn.commit()
    today = dt.date.today(); synced = 0
    try:
        repos = paged("/user/repos", params={"affiliation": "owner,organization_member"})
        if OWNER:
            repos = [r for r in repos if (r.get("owner") or {}).get("login","").lower() == OWNER.lower()]
        print("clio: %d repos" % len(repos))
        for r in repos:
            rid, full = r["id"], r["full_name"]
            cur.execute("""INSERT INTO repos (repo_id, full_name, name, private, archived, fork,
                  language, description, html_url, created_at, pushed_at, last_synced)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
                ON CONFLICT (repo_id) DO UPDATE SET full_name=EXCLUDED.full_name, name=EXCLUDED.name,
                  private=EXCLUDED.private, archived=EXCLUDED.archived, fork=EXCLUDED.fork,
                  language=EXCLUDED.language, description=EXCLUDED.description,
                  html_url=EXCLUDED.html_url, pushed_at=EXCLUDED.pushed_at, last_synced=now()""",
                (rid, full, r["name"], r["private"], r.get("archived",False), r.get("fork",False),
                 r.get("language"), r.get("description"), r.get("html_url"),
                 r.get("created_at"), r.get("pushed_at")))
            cur.execute("""INSERT INTO repo_metrics_daily (repo_id, day, stars, forks, watchers, open_issues, size_kb)
                VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (repo_id, day) DO UPDATE SET
                  stars=EXCLUDED.stars, forks=EXCLUDED.forks, watchers=EXCLUDED.watchers,
                  open_issues=EXCLUDED.open_issues, size_kb=EXCLUDED.size_kb""",
                (rid, today, r.get("stargazers_count",0), r.get("forks_count",0),
                 r.get("watchers_count",0), r.get("open_issues_count",0), r.get("size",0)))

            # Traffic: rolling 14-day window, re-reported every run. GREATEST keeps
            # re-syncs idempotent; a plain overwrite would let a revised-down day
            # shrink stored history.
            views, _ = api("/repos/%s/traffic/views" % full)
            clones, _ = api("/repos/%s/traffic/clones" % full)
            buckets = {}
            for row in (views or {}).get("views", []):
                buckets.setdefault(row["timestamp"][:10], {})["v"] = (row["count"], row["uniques"])
            for row in (clones or {}).get("clones", []):
                buckets.setdefault(row["timestamp"][:10], {})["c"] = (row["count"], row["uniques"])
            for d, b in buckets.items():
                v = b.get("v",(0,0)); c = b.get("c",(0,0))
                cur.execute("""INSERT INTO traffic_daily (repo_id, day, views, views_unique, clones, clones_unique)
                    VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (repo_id, day) DO UPDATE SET
                      views=GREATEST(traffic_daily.views, EXCLUDED.views),
                      views_unique=GREATEST(traffic_daily.views_unique, EXCLUDED.views_unique),
                      clones=GREATEST(traffic_daily.clones, EXCLUDED.clones),
                      clones_unique=GREATEST(traffic_daily.clones_unique, EXCLUDED.clones_unique)""",
                    (rid, d, v[0], v[1], c[0], c[1]))

            # Referrers and paths are top-10 rolling aggregates, stored as dated snapshots.
            refs, _ = api("/repos/%s/traffic/popular/referrers" % full)
            for row in refs or []:
                cur.execute("""INSERT INTO referrers_snapshot (repo_id, captured, referrer, count, uniques)
                    VALUES (%s,%s,%s,%s,%s) ON CONFLICT (repo_id, captured, referrer)
                    DO UPDATE SET count=EXCLUDED.count, uniques=EXCLUDED.uniques""",
                    (rid, today, row["referrer"][:200], row["count"], row["uniques"]))
            paths, _ = api("/repos/%s/traffic/popular/paths" % full)
            for row in paths or []:
                cur.execute("""INSERT INTO paths_snapshot (repo_id, captured, path, title, count, uniques)
                    VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (repo_id, captured, path)
                    DO UPDATE SET count=EXCLUDED.count, uniques=EXCLUDED.uniques""",
                    (rid, today, row["path"][:400], (row.get("title") or "")[:300], row["count"], row["uniques"]))

            # Star history is backfillable via the timestamped stargazer media type.
            if r.get("stargazers_count", 0) > 0:
                for s in paged("/repos/%s/stargazers" % full, accept="application/vnd.github.star+json", cap=10):
                    u = (s.get("user") or {}).get("login")
                    if u and s.get("starred_at"):
                        cur.execute("""INSERT INTO stars (repo_id, user_login, starred_at)
                            VALUES (%s,%s,%s) ON CONFLICT DO NOTHING""", (rid, u, s["starred_at"]))

            # commit_activity returns 52 weeks x 7 days in one call, so a year of
            # commit history backfills on the first sync. Unlike traffic, this is
            # not subject to the 14-day wall.
            act, _ = api("/repos/%s/stats/commit_activity" % full)
            for wk in act or []:
                wstart = dt.datetime.utcfromtimestamp(wk["week"]).date()
                for i, n in enumerate(wk.get("days", [])):
                    if n:
                        cur.execute("""INSERT INTO commits_daily (repo_id, day, commits) VALUES (%s,%s,%s)
                            ON CONFLICT (repo_id, day) DO UPDATE SET commits=EXCLUDED.commits""",
                            (rid, wstart + dt.timedelta(days=i), n))
            synced += 1; conn.commit()
        cur.execute("UPDATE sync_runs SET finished=now(), ok=TRUE, repos_synced=%s, api_calls=%s WHERE id=%s",
                    (synced, CALLS, run_id))
        conn.commit()
        print("clio: ok - %d repos, %d api calls" % (synced, CALLS))
    except Exception as e:
        conn.rollback()
        cur.execute("UPDATE sync_runs SET finished=now(), ok=FALSE, repos_synced=%s, api_calls=%s, error=%s WHERE id=%s",
                    (synced, CALLS, str(e)[:500], run_id))
        conn.commit(); raise
    finally:
        cur.close(); conn.close()

if __name__ == "__main__":
    main()
