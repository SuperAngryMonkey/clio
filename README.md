# Clio &mdash; Debian/LXC

> **Superseded, kept deliberately.** Active development is on the
> [`main`](../../tree/main) branch, which is the default and where
> everything since has landed: daily time series, package download tracking,
> collector alerting, light/dark themes.
>
> This branch is the original self-hosted build — Postgres, systemd, Flask, one
> Linux box. It is not abandoned. A Cloudflare Worker runs at the edge and
> cannot reach a git server that only exists on a LAN, so if Clio is ever
> pointed at **self-hosted git — Gitea, Forgejo, GitLab CE — this is the design
> to come back to.** That is a real possibility, not a courtesy.
>
> It is not receiving fixes in the meantime. Treat it as a starting point
> rather than something to deploy as-is.


*&#7985;&sigma;&tau;&omicron;&rho;&#943;&eta;&sigmaf; &#7936;&pi;&#972;&delta;&epsilon;&xi;&iota;&sigmaf;* — the setting forth of an inquiry.

Clio collects GitHub popularity and activity metrics across a repo fleet and
reports them on one page. Named for the Muse of history: it does not do the
work, it records what was done.


## Run it with Docker

The quickest way to stand this up, and it works anywhere Docker does — inside
an LXC, on a NAS, on a VPS, on a Pi.

```bash
git clone -b debian-lxc https://github.com/SuperAngryMonkey/clio.git
cd clio
cp .env.example .env      # set GITHUB_TOKEN and GITHUB_OWNER
docker compose up -d
```

Then open `http://localhost:8080`.

Three services: Postgres, the Flask dashboard behind gunicorn, and the
collector. The schema is applied automatically the first time the database
initialises. Postgres is not published to the host — only the app containers
can reach it.

The collector runs on an interval inside its own container rather than being
restarted on a schedule, because restart-as-schedule makes a crash loop look
like normal operation. `CLIO_INTERVAL_SECONDS` sets the gap, three hours by
default.

The dashboard uses HTTP Basic auth and expects a credential file — see
`docs/SECURITY.md` for generating it. It lives on the `clio-data` volume, so
it survives `docker compose down`.

### Running in an LXC

Docker needs `nesting=1` on the container, which is off by default:

```bash
pct set <vmid> --features nesting=1,keyctl=1
pct stop <vmid> && pct start <vmid>
```

Verified on Debian 12 (bookworm) in an unprivileged Proxmox LXC with Docker
29.x and overlayfs.

## What it answers

- **Hot** — views, clones, referrers and popular paths per repo, 14-day window
- **Fleet** — commits, languages, staleness across every repo, public and private

Popularity and activity are deliberately separate. Popularity only applies to
public repos with an audience; activity applies to all of them, and for a
single-operator fleet the activity panel is usually the one worth reading.

## Branches

| Branch | Target |
|---|---|
| `main` | LXC / Debian — Postgres, systemd, Flask + gunicorn |
| `cloudflare` | Cloudflare Worker + D1 + Cron Triggers |

Core schema and query logic are shared; the branches differ in runtime only.
Schema changes land on `main` and merge forward.

## Install (LXC)

```
sudo ./install.sh
$EDITOR /opt/clio/.env        # add GITHUB_TOKEN
systemctl start clio-collector.service
journalctl -u clio-collector -n 40
```

Credentials for the dashboard are generated during install and written to
`/root/clio-credentials.txt`.

## Token

A fine-grained GitHub PAT with **Metadata: read** and **Administration: read**
over **all repositories**. Administration is what unlocks the traffic endpoints.
Nothing else is needed — Clio never reads code.

## Docs

`docs/DESIGN.md` for how it works, `docs/OPERATIONS.md` for running it,
`docs/SECURITY.md` for the credential model, `docs/adr/` for decisions and why.
