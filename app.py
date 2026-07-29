#!/usr/bin/env python3
"""Clio web - GitHub popularity + activity dashboard (Flask, served by gunicorn).

Auth is HTTP Basic against a scrypt hash in /opt/clio/webauth, written as
"username:hash". The plaintext is never stored. See docs/SECURITY.md.
"""
import os, functools
from flask import Flask, render_template_string, Response, request
from werkzeug.security import check_password_hash
import psycopg2, psycopg2.extras

AUTH_FILE = "/opt/clio/webauth"
ENV_PATH = "/opt/clio/.env"
app = Flask(__name__)

def load_env(path):
    if not os.path.exists(path): return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env(ENV_PATH)
# Cosmetic only - shown in the footer. Kept out of source so the repo carries
# no tailnet naming (see docs/SECURITY.md).
PUBLIC_HOST = os.environ.get("CLIO_PUBLIC_HOST", "localhost:8080")

def creds():
    try:
        with open(AUTH_FILE, encoding="utf-8") as f:
            u, h = f.read().strip().split(":", 1)
            return u, h
    except Exception:
        return None, None

def protected(fn):
    @functools.wraps(fn)
    def wrap(*a, **kw):
        user, phash = creds()
        auth = request.authorization
        if not user or not auth or auth.username != user or not check_password_hash(phash, auth.password or ""):
            return Response("Authentication required.", 401, {"WWW-Authenticate": 'Basic realm="Clio"'})
        return fn(*a, **kw)
    return wrap

def q(sql, one=False):
    conn = psycopg2.connect("dbname=clio")
    conn.set_client_encoding("UTF8")
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(sql)
    rows = cur.fetchall()
    cur.close(); conn.close()
    return (rows[0] if rows else None) if one else rows

TPL = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Clio</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0c;color:#c8c8d0;font-family:'IBM Plex Mono',monospace;padding:28px;font-size:13px}
.wrap{max-width:1000px;margin:0 auto}
h1{font-family:'Bebas Neue',sans-serif;font-size:42px;letter-spacing:4px;color:#00d4ff;line-height:.9;font-weight:400}
h2{font-family:'Bebas Neue',sans-serif;font-size:17px;letter-spacing:2px;color:#00d4ff;font-weight:400;margin:26px 0 12px}
.ep{font-size:10px;color:#4e4e5c;margin-top:6px;letter-spacing:.5px}
.hdr{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #1e1e26;padding-bottom:14px}
.meta{text-align:right;font-size:11px;color:#5a5a68;line-height:1.7}
.ok{color:#00ff88}.bad{color:#ff6b35}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:9px;margin-top:18px}
.tile{background:#111116;border-radius:6px;padding:11px 13px}
.tile .k{font-size:9px;color:#5a5a68;letter-spacing:.5px}
.tile .v{font-family:'Bebas Neue',sans-serif;font-size:28px;line-height:1.1;color:#e8e8f0}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;font-size:9.5px;color:#5a5a68;letter-spacing:.5px;font-weight:400;padding:5px 8px 5px 0;border-bottom:1px solid #1e1e26}
td{padding:5px 8px 5px 0;border-bottom:1px solid #15151b}
.num{text-align:right;font-variant-numeric:tabular-nums}
.bar{display:inline-block;height:8px;border-radius:2px;vertical-align:middle}
.tag{font-size:9px;padding:1px 5px;border-radius:3px;background:#1c1c24;color:#7a7a88}
.note{font-size:10.5px;color:#5a5a68;margin-top:8px;line-height:1.6}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:26px}
@media(max-width:760px){.cols{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<div class="hdr">
<div><h1>CLIO</h1><div class="ep">&#7985;&sigma;&tau;&omicron;&rho;&#943;&eta;&sigmaf; &#7936;&pi;&#972;&delta;&epsilon;&xi;&iota;&sigmaf;</div></div>
<div class="meta">
{% if run %}<div class="{{ 'ok' if run.ok else 'bad' }}">&#9679; {{ 'sync ok' if run.ok else 'sync FAILED' }}</div>
<div>{{ run.finished.strftime('%Y-%m-%d %H:%M') }} UTC</div>
<div>{{ run.repos_synced }} repos &middot; {{ run.api_calls }} calls</div>
{% else %}<div class="bad">no sync yet</div>{% endif %}
</div></div>
<div class="tiles">
<div class="tile"><div class="k">REPOS</div><div class="v">{{ inv.total }}</div></div>
<div class="tile"><div class="k">PUBLIC</div><div class="v" style="color:#00d4ff">{{ inv.public }}</div></div>
<div class="tile"><div class="k">PRIVATE</div><div class="v">{{ inv.private }}</div></div>
<div class="tile"><div class="k">STARS</div><div class="v" style="color:#ff6b35">{{ inv.stars or 0 }}</div></div>
<div class="tile"><div class="k">FORKS</div><div class="v">{{ inv.forks or 0 }}</div></div>
</div>
<h2>HOT &mdash; 14 day window</h2>
<table><tr><th>repo</th><th></th><th class="num">clones</th><th class="num">peak/day</th><th class="num">views</th><th class="num">peak/day</th></tr>
{% for r in traffic %}<tr>
<td>{{ r.name }} {% if r.private %}<span class="tag">priv</span>{% endif %}</td>
<td style="width:38%"><span class="bar" style="background:#ff6b35;width:{{ (r.clones / maxc * 100) if maxc else 0 }}%"></span>
<span class="bar" style="background:#00d4ff;width:{{ (r.views / maxc * 100) if maxc else 0 }}%"></span></td>
<td class="num" style="color:#ff6b35">{{ r.clones }}</td><td class="num" style="color:#6a6a78">{{ r.peak_clone_uniq }}</td>
<td class="num" style="color:#00d4ff">{{ r.views }}</td><td class="num" style="color:#6a6a78">{{ r.peak_view_uniq }}</td>
</tr>{% endfor %}</table>
<div class="note">Peak/day is the highest single-day unique count, not a sum &mdash; GitHub reports uniques per period, so adding daily values double-counts anything that returns.</div>
<h2>REFERRERS</h2>
{% if referrers %}<table><tr><th>repo</th><th>source</th><th class="num">count</th><th class="num">uniques</th></tr>
{% for r in referrers %}<tr><td>{{ r.name }}</td><td>{{ r.referrer }}</td>
<td class="num">{{ r.count }}</td><td class="num" style="color:#6a6a78">{{ r.uniques }}</td></tr>{% endfor %}</table>
{% else %}<div class="note">No referrer data in the latest snapshot.</div>{% endif %}
<div class="cols">
<div><h2>MOST ACTIVE &mdash; 365d</h2>
<table><tr><th>repo</th><th></th><th class="num">commits</th></tr>
{% for r in active %}<tr><td>{{ r.name }}</td>
<td style="width:45%"><span class="bar" style="background:#00ff88;width:{{ (r.commits / maxa * 100) if maxa else 0 }}%"></span></td>
<td class="num">{{ r.commits }}</td></tr>{% endfor %}</table></div>
<div><h2>GOING COLD</h2>
<table><tr><th>repo</th><th class="num">idle</th></tr>
{% for r in cold %}<tr><td>{{ r.name }} {% if r.private %}<span class="tag">priv</span>{% endif %}</td>
<td class="num" style="color:{{ '#ff6b35' if r.days_idle > 80 else '#eda100' }}">{{ r.days_idle }}d</td></tr>{% endfor %}</table></div>
</div>
<div class="note" style="margin-top:26px;border-top:1px solid #1e1e26;padding-top:12px">
{{ public_host }} &middot; collector runs daily 06:15 UTC</div>
</div></body></html>"""

@app.route("/")
@protected
def index():
    inv = q("""SELECT count(*) total,
                 count(*) FILTER (WHERE NOT private) public,
                 count(*) FILTER (WHERE private) private,
                 (SELECT sum(stars) FROM repo_metrics_daily WHERE day=(SELECT max(day) FROM repo_metrics_daily)) stars,
                 (SELECT sum(forks) FROM repo_metrics_daily WHERE day=(SELECT max(day) FROM repo_metrics_daily)) forks
               FROM repos""", one=True)
    traffic = q("""SELECT r.name, r.private, sum(t.views) views, sum(t.clones) clones,
                     max(t.views_unique) peak_view_uniq, max(t.clones_unique) peak_clone_uniq
                   FROM traffic_daily t JOIN repos r USING(repo_id)
                   WHERE t.day > CURRENT_DATE - 15 GROUP BY r.name, r.private
                   HAVING sum(t.views) + sum(t.clones) > 0
                   ORDER BY clones DESC, views DESC LIMIT 15""")
    referrers = q("""SELECT r.name, s.referrer, s.count, s.uniques
                     FROM referrers_snapshot s JOIN repos r USING(repo_id)
                     WHERE s.captured = (SELECT max(captured) FROM referrers_snapshot)
                     ORDER BY s.count DESC LIMIT 12""")
    active = q("""SELECT r.name, sum(c.commits) commits FROM commits_daily c JOIN repos r USING(repo_id)
                  WHERE c.day > CURRENT_DATE - 366 GROUP BY r.name ORDER BY commits DESC LIMIT 8""")
    cold = q("""SELECT name, private, (CURRENT_DATE - pushed_at::date) days_idle FROM repos
                WHERE pushed_at < now() - interval '60 days' ORDER BY pushed_at LIMIT 8""")
    run = q("SELECT * FROM sync_runs WHERE finished IS NOT NULL ORDER BY id DESC LIMIT 1", one=True)
    return render_template_string(TPL, inv=inv, traffic=traffic, referrers=referrers,
        active=active, cold=cold, run=run, public_host=PUBLIC_HOST,
        maxc=max([t["clones"] for t in traffic] + [1]),
        maxa=max([a["commits"] for a in active] + [1]))

@app.route("/healthz")
def healthz():
    return {"ok": True}

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
