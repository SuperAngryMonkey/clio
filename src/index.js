/**
 * Clio - GitHub popularity and activity reporting on Cloudflare.
 *
 * scheduled(): chunked collector. The free plan caps external subrequests at 50
 * per invocation, and a full sync of ~29 repos costs ~150 GitHub calls, so each
 * run walks a slice of the fleet and stores its position in sync_state. The
 * cron fires every 3 hours; at 8 repos per run the whole fleet is covered
 * roughly twice a day.
 *
 * fetch(): the dashboard. Authentication is Cloudflare Access, which terminates
 * in front of the Worker - see REQUIRE_ACCESS below.
 */

const API = "https://api.github.com";
const MAX_EXTERNAL = 45; // hard stop below the free-plan ceiling of 50

class Budget {
  constructor(limit) { this.limit = limit; this.used = 0; }
  take() { if (this.used >= this.limit) return false; this.used++; return true; }
}

async function gh(env, budget, path, accept = "application/vnd.github+json", retry202 = false) {
  if (!budget.take()) return { data: null, err: "budget exhausted" };
  try {
    const r = await fetch(API + path, {
      headers: {
        Authorization: "Bearer " + env.GITHUB_TOKEN,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "clio-worker",
      },
    });
    // 202 means GitHub is still computing the stats. Retrying would spend
    // subrequests we cannot spare, so skip it; the next cron picks it up.
    if (r.status === 202) {
      // GitHub is computing the stats. The first request for a repo almost always
      // 202s; the second usually succeeds because the request itself triggers the
      // computation. Worth one retry on stats endpoints - without it, commit
      // history only trickles in across days of cron cycles.
      if (retry202) {
        await new Promise((r2) => setTimeout(r2, 3000));
        return gh(env, budget, path, accept, false);
      }
      return { data: null, err: "202 computing" };
    }
    if (!r.ok) return { data: null, err: "HTTP " + r.status };
    return { data: await r.json(), err: null };
  } catch (e) {
    return { data: null, err: String(e).slice(0, 120) };
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const bit = (b) => (b ? 1 : 0);

async function getState(db, k, fallback) {
  const row = await db.prepare("SELECT v FROM sync_state WHERE k = ?").bind(k).first();
  return row ? row.v : fallback;
}

async function setState(db, k, v) {
  await db.prepare(
    "INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ).bind(k, String(v)).run();
}

async function syncSlice(env) {
  const db = env.DB;
  const budget = new Budget(MAX_EXTERNAL);
  const perRun = parseInt(env.REPOS_PER_RUN || "8", 10);
  const d = today();

  const runRes = await db.prepare(
    "INSERT INTO sync_runs (started) VALUES (datetime('now')) RETURNING id"
  ).first();
  const runId = runRes.id;

  let synced = 0, from = 0, to = 0;
  try {
    const { data: all, err } = await gh(env, budget, "/user/repos?per_page=100&affiliation=owner,organization_member");
    if (err || !all) throw new Error("repo list failed: " + err);

    const owner = (env.GITHUB_OWNER || "").toLowerCase();
    const repos = owner
      ? all.filter((r) => (r.owner?.login || "").toLowerCase() === owner)
      : all;
    repos.sort((a, b) => a.full_name.localeCompare(b.full_name));

    const cursor = parseInt(await getState(db, "cursor", "0"), 10) % Math.max(repos.length, 1);
    const slice = repos.slice(cursor, cursor + perRun);
    from = cursor; to = cursor + slice.length;

    for (const r of slice) {
      const id = r.repo_id ?? r.id;
      const full = r.full_name;
      const stmts = [];

      stmts.push(db.prepare(`
        INSERT INTO repos (repo_id, full_name, name, private, archived, fork, language,
                           description, html_url, created_at, pushed_at, last_synced)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(repo_id) DO UPDATE SET
          full_name=excluded.full_name, name=excluded.name, private=excluded.private,
          archived=excluded.archived, fork=excluded.fork, language=excluded.language,
          description=excluded.description, html_url=excluded.html_url,
          pushed_at=excluded.pushed_at, last_synced=datetime('now')`)
        .bind(id, full, r.name, bit(r.private), bit(r.archived), bit(r.fork),
              r.language ?? null, r.description ?? null, r.html_url ?? null,
              r.created_at ?? null, r.pushed_at ?? null));

      stmts.push(db.prepare(`
        INSERT INTO repo_metrics_daily (repo_id, day, stars, forks, watchers, open_issues, size_kb)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(repo_id, day) DO UPDATE SET
          stars=excluded.stars, forks=excluded.forks, watchers=excluded.watchers,
          open_issues=excluded.open_issues, size_kb=excluded.size_kb`)
        .bind(id, d, r.stargazers_count ?? 0, r.forks_count ?? 0,
              r.watchers_count ?? 0, r.open_issues_count ?? 0, r.size ?? 0));

      // Traffic: rolling 14-day window, re-reported every sync. MAX() on conflict
      // keeps re-syncs idempotent and stops a downward revision shrinking history.
      const views = (await gh(env, budget, `/repos/${full}/traffic/views`)).data;
      const clones = (await gh(env, budget, `/repos/${full}/traffic/clones`)).data;
      const buckets = new Map();
      for (const v of views?.views ?? []) {
        const k = v.timestamp.slice(0, 10);
        buckets.set(k, { ...(buckets.get(k) || {}), v: [v.count, v.uniques] });
      }
      for (const c of clones?.clones ?? []) {
        const k = c.timestamp.slice(0, 10);
        buckets.set(k, { ...(buckets.get(k) || {}), c: [c.count, c.uniques] });
      }
      for (const [day, b] of buckets) {
        const [vc, vu] = b.v || [0, 0];
        const [cc, cu] = b.c || [0, 0];
        stmts.push(db.prepare(`
          INSERT INTO traffic_daily (repo_id, day, views, views_unique, clones, clones_unique)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(repo_id, day) DO UPDATE SET
            views=MAX(traffic_daily.views, excluded.views),
            views_unique=MAX(traffic_daily.views_unique, excluded.views_unique),
            clones=MAX(traffic_daily.clones, excluded.clones),
            clones_unique=MAX(traffic_daily.clones_unique, excluded.clones_unique)`)
          .bind(id, day, vc, vu, cc, cu));
      }

      // Referrers and paths are rolling top-10 aggregates; stored as dated snapshots.
      for (const x of (await gh(env, budget, `/repos/${full}/traffic/popular/referrers`)).data ?? []) {
        stmts.push(db.prepare(`
          INSERT INTO referrers_snapshot (repo_id, captured, referrer, count, uniques)
          VALUES (?,?,?,?,?) ON CONFLICT(repo_id, captured, referrer)
          DO UPDATE SET count=excluded.count, uniques=excluded.uniques`)
          .bind(id, d, String(x.referrer).slice(0, 200), x.count, x.uniques));
      }
      for (const x of (await gh(env, budget, `/repos/${full}/traffic/popular/paths`)).data ?? []) {
        stmts.push(db.prepare(`
          INSERT INTO paths_snapshot (repo_id, captured, path, title, count, uniques)
          VALUES (?,?,?,?,?,?) ON CONFLICT(repo_id, captured, path)
          DO UPDATE SET count=excluded.count, uniques=excluded.uniques`)
          .bind(id, d, String(x.path).slice(0, 400), String(x.title ?? "").slice(0, 300),
                x.count, x.uniques));
      }

      // One call returns 52 weeks x 7 days, so a year of commit history backfills
      // immediately. Unlike traffic, this is not subject to the 14-day wall.
      for (const wk of (await gh(env, budget, `/repos/${full}/stats/commit_activity`, undefined, true)).data ?? []) {
        const start = new Date(wk.week * 1000);
        (wk.days ?? []).forEach((n, i) => {
          if (!n) return;
          const dt = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
          stmts.push(db.prepare(`
            INSERT INTO commits_daily (repo_id, day, commits) VALUES (?,?,?)
            ON CONFLICT(repo_id, day) DO UPDATE SET commits=excluded.commits`)
            .bind(id, dt, n));
        });
      }

      // Star history carries timestamps via the star+json media type. Only worth
      // a subrequest when the count is non-zero.
      if ((r.stargazers_count ?? 0) > 0) {
        const sg = (await gh(env, budget, `/repos/${full}/stargazers?per_page=100`,
                             "application/vnd.github.star+json")).data ?? [];
        for (const s of sg) {
          if (s.user?.login && s.starred_at) {
            stmts.push(db.prepare(
              "INSERT OR IGNORE INTO stars (repo_id, user_login, starred_at) VALUES (?,?,?)"
            ).bind(id, s.user.login, s.starred_at));
          }
        }
      }

      // Batched so one repo is a single D1 round trip rather than dozens.
      await db.batch(stmts);
      synced++;
    }

    const next = (cursor + slice.length) % Math.max(repos.length, 1);
    await setState(db, "cursor", next);
    await setState(db, "fleet_size", repos.length);
    await db.prepare(`UPDATE sync_runs SET finished=datetime('now'), ok=1,
        repos_synced=?, api_calls=?, slice_from=?, slice_to=? WHERE id=?`)
      .bind(synced, budget.used, from, to, runId).run();
    return { ok: true, synced, calls: budget.used, from, to, next, fleet: repos.length };
  } catch (e) {
    await db.prepare(`UPDATE sync_runs SET finished=datetime('now'), ok=0,
        repos_synced=?, api_calls=?, error=? WHERE id=?`)
      .bind(synced, budget.used, String(e).slice(0, 400), runId).run();
    return { ok: false, error: String(e), synced, calls: budget.used };
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- time series rendering -------------------------------------------------
// Days absent from the table are GAPS, not zeros: at REPOS_PER_RUN per 3h a full
// fleet cycle takes ~1.5 days, so early per-repo rows are unevenly dense. A day
// present with value 0 is a real zero and is drawn; a missing day breaks the line.

function densify(rows, key, days) {
  const m = new Map(rows.map((r) => [r.day, r[key]]));
  return days.map((d) => (m.has(d) ? (m.get(d) ?? 0) : null));
}

function dayAxis(rows) {
  if (!rows.length) return [];
  const out = [];
  const start = new Date(rows[0].day + "T00:00:00Z");
  const end = new Date(rows[rows.length - 1].day + "T00:00:00Z");
  for (let t = start; t <= end; t.setUTCDate(t.getUTCDate() + 1)) {
    out.push(t.toISOString().slice(0, 10));
  }
  return out;
}

function chart(rows, commitRows) {
  if (!rows.length) return '<div class="note">No time-series data yet &mdash; the collector needs at least one completed slice.</div>';
  const days = dayAxis(rows);
  const n = days.length;
  const W = 940, L = 34, R = 10;
  const x = (i) => L + (i * (W - L - R)) / Math.max(n - 1, 1);

  // Small multiples: one panel per series, each with its own y-scale, sharing a
  // single x-axis. A shared y would let one 93-view day flatten a 27-clone surge
  // into the floor. Dual-axis is not the answer -- two scales on one frame invite
  // the reader to compare heights that are not comparable.
  const panel = (arr, opt) => {
    const H = opt.h, T = 10, B = 14;
    const vals = arr.filter((v) => v != null);
    const max = Math.max(1, ...vals);
    const y = (v) => H - B - (v / max) * (H - T - B);
    let d = "", pen = false, area = "", run = [];
    const flushArea = () => {
      if (opt.area && run.length > 1) {
        area += `<path d="M${x(run[0]).toFixed(1)} ${(H - B).toFixed(1)} ` +
          run.map((i) => `L${x(i).toFixed(1)} ${y(arr[i]).toFixed(1)}`).join(" ") +
          ` L${x(run[run.length - 1]).toFixed(1)} ${(H - B).toFixed(1)} Z" fill="${opt.color}" opacity=".10"/>`;
      }
      run = [];
    };
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) { pen = false; flushArea(); continue; }
      d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(arr[i]).toFixed(1) + " ";
      pen = true; run.push(i);
    }
    flushArea();
    const grid = [0, 1].map((f) => {
      const gy = (H - B - f * (H - T - B)).toFixed(1);
      return `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" stroke="#1e1e26" stroke-width="1"/>` +
        `<text x="${L - 6}" y="${(+gy + 3).toFixed(1)}" fill="#4e4e5c" font-size="9" text-anchor="end">${Math.round(f * max)}</text>`;
    }).join("");
    const bars = opt.bars ? arr.map((v, i) => v
      ? `<rect x="${(x(i) - 1.5).toFixed(1)}" y="${y(v).toFixed(1)}" width="3" height="${(H - B - y(v)).toFixed(1)}" fill="${opt.color}" opacity=".55"/>`
      : "").join("") : "";
    const line = opt.bars ? "" :
      `<path d="${d.trim()}" fill="none" stroke="${opt.color}" stroke-width="${opt.w || 1.8}"${opt.dash ? ' stroke-dasharray="4 3"' : ""} stroke-linejoin="round"/>`;
    return `<div style="margin-bottom:2px"><div style="font-size:10px;color:${opt.color};letter-spacing:.08em;padding-left:${L}px">${opt.label} &middot; peak ${max}</div>
<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${opt.label} per day, peak ${max}" style="display:block">${grid}${area}${bars}${line}</svg></div>`;
  };

  const step = Math.max(1, Math.ceil(n / 12));
  const axis = `<svg viewBox="0 0 ${W} 16" width="100%" aria-hidden="true" style="display:block">` +
    days.map((d, i) => (i % step === 0 || i === n - 1)
      ? `<text x="${x(i).toFixed(1)}" y="11" fill="#4e4e5c" font-size="9" text-anchor="middle">${d.slice(5)}</text>` : "").join("") +
    `</svg>`;

  return panel(densify(rows, "clones", days), { label: "CLONES", color: "#ff6b35", h: 96, area: true }) +
    panel(densify(rows, "views", days), { label: "VIEWS", color: "#00d4ff", h: 84, dash: true, w: 1.6 }) +
    panel(densify(commitRows, "commits", days), { label: "COMMITS", color: "#00ff88", h: 60, bars: true }) +
    axis +
    `<div class="note">Each panel has its own vertical scale &mdash; compare shape and timing across panels, not height. ${n} days, ${rows.length} with data.</div>`;
}


function spark(rows, days, fleetMax) {
  // Normalized to the fleet max, not the row max: a per-row scale made a 3-clone
  // repo spike as tall as a 33-clone one. The table already carries the counts,
  // so the sparkline's job is WHEN, at honest relative magnitude.
  if (!rows || !rows.length) return "";
  const arr = densify(rows, "clones", days);
  if (!arr.some((v) => v)) return "";  // no clones at all: draw nothing, not a flat line
  const W = 74, H = 16;
  const max = Math.max(1, fleetMax || 1);
  const n = days.length;
  let d = "", pen = false;
  for (let i = 0; i < n; i++) {
    if (arr[i] == null) { pen = false; continue; }
    const px = ((i * W) / Math.max(n - 1, 1)).toFixed(1);
    const py = (H - 2 - (Math.min(arr[i], max) / max) * (H - 4)).toFixed(1);
    d += (pen ? "L" : "M") + px + " " + py + " ";
    pen = true;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="vertical-align:middle" aria-hidden="true"><path d="${d.trim()}" fill="none" stroke="#ff6b35" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
}


function page(d) {
  const maxc = Math.max(1, ...d.traffic.map((t) => t.clones || 0));
  const maxa = Math.max(1, ...d.active.map((a) => a.commits || 0));
  const sdays = dayAxis(d.series);
  const fleetMax = Math.max(1, ...Object.values(d.spark)
    .flatMap((rs) => rs.map((r) => r.clones || 0)));
  const row = (t) => `<tr><td>${esc(t.name)}${t.private ? ' <span class="tag">priv</span>' : ""}</td>
<td style="width:80px">${spark(d.spark[t.name], sdays, fleetMax)}</td>
<td style="width:38%"><span class="bar" style="background:#ff6b35;width:${(t.clones / maxc) * 100}%"></span>
<span class="bar" style="background:#00d4ff;width:${(t.views / maxc) * 100}%"></span></td>
<td class="num" style="color:#ff6b35">${t.clones}</td><td class="num" style="color:#6a6a78">${t.peak_clone_uniq ?? 0}</td>
<td class="num" style="color:#00d4ff">${t.views}</td><td class="num" style="color:#6a6a78">${t.peak_view_uniq ?? 0}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Clio</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0c;color:#c8c8d0;font-family:'IBM Plex Mono',monospace;padding:28px;font-size:13px}
.wrap{width:100%;max-width:1000px;margin:0 auto}
h1{font-family:'Bebas Neue',sans-serif;font-size:42px;letter-spacing:4px;color:#00d4ff;line-height:.9;font-weight:400}
h2{font-family:'Bebas Neue',sans-serif;font-size:17px;letter-spacing:2px;color:#00d4ff;font-weight:400;margin:26px 0 12px}
.ep{font-size:10px;color:#4e4e5c;margin-top:6px;letter-spacing:.5px}
.hdr{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #1e1e26;padding-bottom:14px}
.meta{text-align:right;font-size:11px;color:#5a5a68;line-height:1.7}
.ok{color:#00ff88}.bad{color:#ff6b35}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(115px,1fr));gap:9px;margin-top:18px}
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
/* Wide screens: give the page room. A 4K panel at 200% scaling reports a
   1920px viewport, so these are CSS-pixel breakpoints, not resolutions. */
@media(min-width:1500px){.wrap{max-width:1400px}body{padding:34px}}
@media(min-width:2100px){.wrap{max-width:1750px}body{font-size:14px}}
</style></head><body><div class="wrap">
<div class="hdr">
<div><h1>CLIO</h1><div class="ep">&#7985;&sigma;&tau;&omicron;&rho;&#943;&eta;&sigmaf; &#7936;&pi;&#972;&delta;&epsilon;&xi;&iota;&sigmaf;</div></div>
<div class="meta">${d.run
  ? `<div class="${d.run.ok ? "ok" : "bad"}">&#9679; ${d.run.ok ? "sync ok" : "sync FAILED"}</div>
     <div>${esc(d.run.finished)} UTC</div>
     <div>slice ${d.run.slice_from}&ndash;${d.run.slice_to} &middot; ${d.run.api_calls} calls</div>`
  : '<div class="bad">no sync yet</div>'}
<div>${esc(d.user || "")}</div></div></div>
<div class="tiles">
<div class="tile"><div class="k">REPOS</div><div class="v">${d.inv.total ?? 0}</div></div>
<div class="tile"><div class="k">PUBLIC</div><div class="v" style="color:#00d4ff">${d.inv.pub ?? 0}</div></div>
<div class="tile"><div class="k">PRIVATE</div><div class="v">${d.inv.priv ?? 0}</div></div>
<div class="tile"><div class="k">STARS</div><div class="v" style="color:#ff6b35">${d.inv.stars ?? 0}</div></div>
<div class="tile"><div class="k">FORKS</div><div class="v">${d.inv.forks ?? 0}</div></div>
</div>
<h2>ACTIVITY &mdash; ${d.seriesDays}d</h2>
${chart(d.series, d.commitSeries)}
<div class="note">GitHub keeps 14 days and discards the rest; everything left of that line exists only here. Gaps are gaps, not zeros &mdash; a day with no row was never collected.</div>
<h2>HOT &mdash; 14 day window</h2>
<table><tr><th>repo</th><th title="30d clones, all rows on one scale">trend</th><th></th><th class="num">clones</th><th class="num">peak/day</th><th class="num">views</th><th class="num">peak/day</th></tr>
${d.traffic.map(row).join("")}</table>
<div class="note">Peak/day is the highest single-day unique count, never a sum &mdash; GitHub reports uniques per period, so adding daily values double-counts anything that returns.</div>
<h2>REFERRERS</h2>
${d.referrers.length
  ? `<table><tr><th>repo</th><th>source</th><th class="num">count</th><th class="num">uniques</th></tr>
     ${d.referrers.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.referrer)}</td><td class="num">${r.count}</td><td class="num" style="color:#6a6a78">${r.uniques}</td></tr>`).join("")}</table>`
  : '<div class="note">No referrer data in the latest snapshot.</div>'}
<div class="cols">
<div><h2>MOST ACTIVE &mdash; 365d</h2><table><tr><th>repo</th><th></th><th class="num">commits</th></tr>
${d.active.map((a) => `<tr><td>${esc(a.name)}</td><td style="width:45%"><span class="bar" style="background:#00ff88;width:${(a.commits / maxa) * 100}%"></span></td><td class="num">${a.commits}</td></tr>`).join("")}</table></div>
<div><h2>GOING COLD</h2><table><tr><th>repo</th><th class="num">idle</th></tr>
${d.cold.map((c) => `<tr><td>${esc(c.name)}${c.private ? ' <span class="tag">priv</span>' : ""}</td><td class="num" style="color:${c.days_idle > 80 ? "#ff6b35" : "#eda100"}">${c.days_idle}d</td></tr>`).join("")}</table></div>
</div>
<div class="note" style="margin-top:26px;border-top:1px solid #1e1e26;padding-top:12px">
Cloudflare Worker + D1 &middot; collector every 3h, ${d.perRun} repos per slice, fleet ${d.fleet}
&middot; <a href="/sync" style="color:#00d4ff">sync next slice now</a></div>
</div></body></html>`;
}

export default {
  async scheduled(event, env, ctx) {
    const res = await syncSlice(env);
    console.log("clio sync:", JSON.stringify(res));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    // Cloudflare Access terminates in front of this Worker and injects these
    // headers. With REQUIRE_ACCESS=1 the Worker refuses anything that did not
    // come through Access, so a misconfigured route cannot expose the data.
    const email = request.headers.get("Cf-Access-Authenticated-User-Email");
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if ((env.REQUIRE_ACCESS ?? "1") === "1" && !(email || jwt)) {
      return new Response(
        "Cloudflare Access required.\n\nThis Worker refuses requests that did not arrive through Access.\n" +
        "Configure an Access application for this hostname, or set REQUIRE_ACCESS=0 in\n" +
        "wrangler.toml to bypass temporarily.\n",
        { status: 403, headers: { "content-type": "text/plain" } }
      );
    }

    // Manual trigger. Behind the Access check, so only an authenticated session
    // can advance the cursor. GET redirects back to the dashboard so it works as
    // a plain link; POST returns JSON for scripting.
    // Machine-readable daily series. Uniques are returned per-day only; never
    // sum them across days (see docs/adr/0002) -- peak-per-day is the honest
    // aggregate because GitHub reports uniques per period.
    if (url.pathname === "/api/series") {
      const n = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days") || "90", 10) || 90));
      const repo = url.searchParams.get("repo");
      const q = repo
        ? env.DB.prepare(`SELECT t.day, t.views, t.views_unique, t.clones, t.clones_unique
              FROM traffic_daily t JOIN repos r ON r.repo_id=t.repo_id
              WHERE r.name = ? AND t.day > date('now','-' || ? || ' days')
              ORDER BY t.day`).bind(repo, n)
        : env.DB.prepare(`SELECT day, sum(views) views, max(views_unique) peak_views_unique,
                sum(clones) clones, max(clones_unique) peak_clones_unique
              FROM traffic_daily WHERE day > date('now','-' || ? || ' days')
              GROUP BY day ORDER BY day`).bind(n);
      const { results } = await q.all();
      return Response.json({
        scope: repo || "fleet", days: n, note: "uniques are per-day; do not sum",
        series: results,
      });
    }

    if (url.pathname === "/sync") {
      const res = await syncSlice(env);
      if (request.method === "POST") return Response.json(res);
      return new Response(null, { status: 303, headers: { Location: "/" } });
    }

    const db = env.DB;
    const seriesDays = 90;
    const [inv, traffic, referrers, active, cold, run, fleet, series, commitSeries, sparkRows] = await Promise.all([
      db.prepare(`SELECT count(*) total,
            sum(CASE WHEN private=0 THEN 1 ELSE 0 END) pub,
            sum(CASE WHEN private=1 THEN 1 ELSE 0 END) priv,
            (SELECT sum(stars) FROM repo_metrics_daily WHERE day=(SELECT max(day) FROM repo_metrics_daily)) stars,
            (SELECT sum(forks) FROM repo_metrics_daily WHERE day=(SELECT max(day) FROM repo_metrics_daily)) forks
          FROM repos`).first(),
      db.prepare(`SELECT r.name, r.private, sum(t.views) views, sum(t.clones) clones,
            max(t.views_unique) peak_view_uniq, max(t.clones_unique) peak_clone_uniq
          FROM traffic_daily t JOIN repos r ON r.repo_id=t.repo_id
          WHERE t.day > date('now','-15 days')
          GROUP BY r.name, r.private HAVING sum(t.views)+sum(t.clones) > 0
          ORDER BY clones DESC, views DESC LIMIT 15`).all(),
      db.prepare(`SELECT r.name, s.referrer, s.count, s.uniques
          FROM referrers_snapshot s JOIN repos r ON r.repo_id=s.repo_id
          WHERE s.captured=(SELECT max(captured) FROM referrers_snapshot)
          ORDER BY s.count DESC LIMIT 12`).all(),
      db.prepare(`SELECT r.name, sum(c.commits) commits
          FROM commits_daily c JOIN repos r ON r.repo_id=c.repo_id
          WHERE c.day > date('now','-366 days')
          GROUP BY r.name ORDER BY commits DESC LIMIT 8`).all(),
      db.prepare(`SELECT name, private,
            CAST(julianday('now') - julianday(pushed_at) AS INTEGER) days_idle
          FROM repos WHERE pushed_at IS NOT NULL
            AND julianday('now') - julianday(pushed_at) > 60
          ORDER BY pushed_at LIMIT 8`).all(),
      db.prepare("SELECT * FROM sync_runs WHERE finished IS NOT NULL ORDER BY id DESC LIMIT 1").first(),
      db.prepare("SELECT v FROM sync_state WHERE k='fleet_size'").first(),
      db.prepare(`SELECT day, sum(views) views, sum(clones) clones
          FROM traffic_daily WHERE day > date('now','-' || ? || ' days')
          GROUP BY day ORDER BY day`).bind(seriesDays).all(),
      db.prepare(`SELECT day, sum(commits) commits
          FROM commits_daily WHERE day > date('now','-' || ? || ' days')
          GROUP BY day HAVING sum(commits) > 0 ORDER BY day`).bind(seriesDays).all(),
      db.prepare(`SELECT r.name, t.day, t.clones
          FROM traffic_daily t JOIN repos r ON r.repo_id=t.repo_id
          WHERE t.day > date('now','-30 days') ORDER BY t.day`).all(),
    ]);

    const spark = {};
    for (const r of sparkRows.results) (spark[r.name] ||= []).push({ day: r.day, clones: r.clones });

    return new Response(page({
      inv: inv || {}, traffic: traffic.results, referrers: referrers.results,
      active: active.results, cold: cold.results, run, user: email,
      perRun: env.REPOS_PER_RUN || "8", fleet: fleet?.v ?? "?",
      series: series.results, commitSeries: commitSeries.results, spark, seriesDays,
    }), { headers: { "content-type": "text/html;charset=utf-8" } });
  },
};
