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
| Dashboard | Worker `fetch()`, server-rendered HTML |
| Auth | Cloudflare Access in front of the Worker |
| Secrets | `GITHUB_TOKEN` as a Worker secret |

No build step, no framework, no dependencies at runtime. wrangler is the only
devDependency.

## What it answers

- **Hot** — views, clones, referrers and popular paths per repo, 14-day window
- **Fleet** — commits and staleness across every repo, public and private

These are deliberately separate. Popularity only means anything for public repos
with an audience; activity applies to all of them. For a single-operator fleet
the activity panel is usually the one worth reading.

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
