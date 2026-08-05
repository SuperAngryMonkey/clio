# Clio &mdash; Cloudflare

*&#7985;&sigma;&tau;&omicron;&rho;&#943;&eta;&sigmaf; &#7936;&pi;&#972;&delta;&epsilon;&xi;&iota;&sigmaf;* — the setting forth of an inquiry.

GitHub popularity and activity reporting for a repo fleet, as a single Cloudflare
Worker. Named for the Muse of history: it does not do the work, it records what
was done.

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

## Time series

GitHub's traffic API returns a rolling 14-day window and keeps nothing older.
Clio upserts each day into `traffic_daily` keyed `(repo_id, day)`, so history
accumulates from the day you deploy it. Past the first fortnight, the chart is
showing you data that no longer exists anywhere else.

The **Activity** panel plots daily clones (area and line), views (dashed) and
commits (bars, on their own scale) over 90 days. Each row of the **Hot** table
carries a 30-day clone sparkline. Charts are inline SVG generated in the Worker
— no chart library, no CDN, nothing to fail behind Access.

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
