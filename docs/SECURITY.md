# Security

## Credentials and where they live

| Secret | Location | Notes |
|---|---|---|
| GitHub PAT | `/opt/clio/.env`, 0600, owned by `clio` | gitignored |
| Dashboard password | scrypt hash in `/opt/clio/webauth`, 0600 | plaintext never stored |
| Postgres | none | peer auth over unix socket |

Postgres uses peer authentication, so there is **no database password anywhere**
on disk or in config.

The dashboard password is generated on the host during install and written once
to `/root/clio-credentials.txt` (0600, root). The application only ever sees the
hash.

## Token scope

Metadata: read + Administration: read, all repositories. Administration is
broader than it sounds — it grants read access to repo settings and webhook
configuration across the fleet. It is required for the traffic endpoints and
there is no narrower option. Clio has no Contents scope and cannot read code.

Fine-grained tokens expire. Expiry is silent: the timer fires, the sync fails,
and nothing tells you. Record the expiry date somewhere you will see it.

## Repository hygiene

This repo must contain **no tailnet hostnames, no tailnet or RFC1918 addresses,
and no account identifiers**. Topology in tracked files was the single largest
exposure class in a prior fleet-wide audit — not credentials, but inventory.

The dashboard footer hostname comes from `CLIO_PUBLIC_HOST` in `.env` for exactly
this reason. Before committing:

```
grep -rn -E 'ts\.net|100\.[0-9]+\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+' .
```

## Exposure

`clio-web.service` binds `0.0.0.0`, so it is reachable on any network the host
sits on, not only the tailnet. Basic Auth is the only control. Narrow the bind
address, or front it with an identity proxy, if the host is not isolated.
