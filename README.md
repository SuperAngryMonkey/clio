# Clio &mdash; Cloudflare

*&#7985;&sigma;&tau;&omicron;&rho;&#943;&eta;&sigmaf; &#7936;&pi;&#972;&delta;&epsilon;&xi;&iota;&sigmaf;* — the setting forth of an inquiry.

GitHub popularity and activity reporting for a repo fleet, as a single Cloudflare
Worker. Named for the Muse of history: it does not do the work, it records what
was done.

**It runs entirely on Cloudflare's free tier, and is designed to.** No paid plan,
no card on file, no server. The free-tier ceilings are not incidental here — the
50-subrequest cap is the reason the collector is chunked rather than a simple
loop. See [Free tier](#free-tier).

This is the `cloudflare` branch. For the Debian/LXC deployment — Postgres,
systemd, Flask — see `main`.

## Shape

| Piece | Implementation |
|---|---|
| Collector | Worker `scheduled()`, Cron Trigger every 3h |
| Storage | D1 (SQLite) |
| Dashboard | Worker `fetch()`, server-rendered HTML, inline SVG charts |
| JSON API | `GET /api/series` for the daily series |
| Auth | Cloudflare Access in front of the Worker |
| Secrets | `GITHUB_TOKEN` as a Worker secret |

No build step, no framework, no dependencies at runtime. wrangler is the only
devDependency.

## What it answers

- **Hot** — views, clones, referrers and popular paths per repo, 14-day window
- **Fleet** — commits and staleness across every repo, public and private
- **Activity** — the same numbers as a daily series, for as far back as Clio has been running

These are deliberately separate. Popularity only means anything for public repos
with an audience; activity applies to all of them. For a single-operator fleet
the activity panel is usually the one worth reading.

## Free tier

Everything below is the Workers **Free** plan plus the Zero Trust **Free** plan.
Total cost of running this: nothing, indefinitely. Cloudflare has committed to
keeping a free D1 tier. The only thing you pay for is a domain, and Clio works
on a `workers.dev` subdomain if you would rather not have one.

### What the free plan gives you

| Limit | Free | What Clio does |
|---|---|---|
| Worker requests | 100,000/day | ~8 cron runs/day + dashboard loads |
| CPU per invocation | 10 ms | string-building only; no parsing, no crypto |
| **External subrequests per invocation** | **50** | **the binding constraint — see below** |
| Cron Triggers | 5 per account | 1 |
| Workers | 100 per account | 1 |
| D1 databases | 10 per account | 1 |
| D1 database size | 500 MB | ~200 KB after a month of a 30-repo fleet |
| D1 storage per account | 5 GB | as above |
| D1 rows read | 5,000,000/day | hundreds |
| D1 rows written | 100,000/day | low hundreds |
| D1 Time Travel | 7 days | free point-in-time recovery |
| Zero Trust users | 50 | 1 |
| Zero Trust log retention | 24 hours | — |

Daily counters reset at 00:00 UTC. Exceeding a Worker limit returns error 1027;
exceeding a D1 daily limit makes queries fail until reset; filling D1 storage
blocks inserts and schema changes until you delete something.

### The 50-subrequest cap is the whole design

A Worker on the free plan may make **50 external subrequests per invocation**.
Paid plans get 10,000. Every GitHub API call is one subrequest, and a full fleet
sync needs roughly five calls per repo — repo metadata, views, clones,
referrers, paths — so a 30-repo fleet is about 150 calls. Three times over the
ceiling.

Rather than upgrade, the collector processes a **slice** of the fleet per run
and keeps a cursor in `sync_state`. `REPOS_PER_RUN` sets the slice; a `Budget`
guard aborts at 45 calls so a retry or a `202` from GitHub's stats endpoints
cannot push a run over the edge. Cron fires every 3 hours, so the fleet is
walked in `fleet_size / REPOS_PER_RUN` runs — for 30 repos at 7 per run, about
half a day.

This is why per-repo daily rows can be sparse in the first days after deploying,
and why the charts draw gaps rather than zeros. The sparseness is the free tier
showing through the data. It is a fair trade: the alternative is $5/month for a
dashboard one person reads.

### Two things to keep an eye on

**D1 queries per invocation.** Cloudflare's D1 limits page lists *queries per
Worker invocation* as 50 on Free against 1000 on Paid, while the Workers
changelog describes free-plan Workers as limited to 50 *external* subrequests
and 1000 to Cloudflare services. The docs are in tension, so treat 50 as the
number to design against. The dashboard currently issues 10 D1 queries per page
load. There is room, but it is not unlimited — count your queries before adding
another panel.

**10 ms of CPU.** Waiting on `fetch()` and D1 does not count; only your own
computation does. Chart generation is the CPU-heaviest thing here, and it is
string concatenation over at most a few hundred points. If you widen the window
far beyond 90 days or render a panel per repo, this is the limit that bites
first, and it fails as error 1102 rather than a slow page.

### Where the free tier does bite

- **No alerting.** Nothing tells you when a cron run fails; you check
  `sync_runs` or you do not know. This is a gap in Clio, not in Cloudflare.
- **24-hour Access logs.** Who reached the dashboard last week is not
  answerable after a day.
- **7-day Time Travel** instead of 30. Restoring D1 to a point before last week
  is not an option, so treat the GitHub API as the real source of truth for the
  last 14 days and Clio as the only source beyond that.

## Time series

GitHub's traffic API returns a rolling 14-day window and keeps nothing older.
Clio upserts each day into `traffic_daily` keyed `(repo_id, day)`, so history
accumulates from the day you deploy it. Past the first fortnight, the chart is
showing you data that no longer exists anywhere else.

The **Activity** panel is a set of small multiples: separate stacked panels for
clones, views and commits over 90 days, each with its own vertical scale,
sharing one x-axis. Compare shape and timing across panels, not height. A single
shared scale would let one busy view-day flatten a clone surge into the floor,
and a dual axis would invite exactly the height comparison that is not valid.

Each row of the **Hot** table carries a 30-day clone sparkline, normalized to
the busiest repo in the fleet rather than to itself — so a quiet repo looks
quiet. Rows with no clones draw nothing at all, because a flat line reads as
data rather than absence.

Charts are inline SVG generated in the Worker — no chart library, no CDN,
nothing to fail behind Access.

### Gaps are gaps

The collector walks a slice of the fleet per run, so a full cycle takes roughly
`fleet_size / REPOS_PER_RUN` runs — over a day for a large fleet. Days with no
row were never collected and render as a break in the line. A day present with
value `0` is a real zero and is drawn as one. Nothing is interpolated.

### Never sum uniques

GitHub reports unique cloners and visitors *per period*, so adding daily values
double-counts anyone who came back. Every unique figure here is per-day, and
fleet-level aggregates report peak-per-day rather than a total. See
`docs/adr/0002`.

### `GET /api/series`

| Parameter | Default | Meaning |
|---|---|---|
| `days` | `90` | window length, 1&ndash;365 |
| `repo` | *(none)* | repo name; omit for fleet-wide totals |

```
curl https://YOUR-HOST/api/series?days=30
curl https://YOUR-HOST/api/series?days=30&repo=some-repo
```

Fleet scope returns `views`, `clones`, `peak_views_unique` and
`peak_clones_unique` per day. Repo scope returns that repo's raw daily rows.
Behind Access like everything else, so a script needs a service token.

## Quick start

```
npm install
cp wrangler.toml.example wrangler.toml   # then fill in domain + owner
npx wrangler d1 create clio              # paste the id into wrangler.toml
npx wrangler d1 migrations apply clio --remote
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

Then configure Access. Full walkthrough including the two Cloudflare gotchas that
cost real time: **`docs/SETUP-CLOUDFLARE.md`**.

## Operating it

The dashboard footer has a **sync next slice now** link — the collector processes
part of the fleet per run, so this fills it in faster than waiting for cron.

```
npx wrangler d1 execute clio --remote \
  --command "SELECT id,finished,ok,repos_synced,api_calls,error \
             FROM sync_runs ORDER BY id DESC LIMIT 3"
```

## Docs

| File | Contents |
|---|---|
| `docs/SETUP-CLOUDFLARE.md` | build from nothing, including gotchas |
| `docs/DESIGN.md` | how it works and why |
| `docs/OPERATIONS.md` | running it, failure modes |
| `docs/SECURITY.md` | credential model, exposure |
| `docs/HANDOFF.md` | current state, open threads |
| `docs/adr/` | decisions with their reasoning |

## Token

A fine-grained GitHub PAT with **Metadata: read** and **Administration: read**
over all repositories. Administration unlocks the traffic endpoints. Clio has no
Contents scope and cannot read code.
