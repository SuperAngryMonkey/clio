# Security &mdash; Cloudflare

## Credentials

| Secret | Where | Notes |
|---|---|---|
| GitHub PAT | Worker secret `GITHUB_TOKEN` | encrypted at rest, not in the repo |
| Dashboard auth | Cloudflare Access | no password stored anywhere |
| D1 | binding, no credential | access is via account auth |

There is no password anywhere in this deployment. Access handles identity and the
Worker never sees a credential it has to verify.

Never put the PAT in `[vars]` — vars are plaintext in the deployed config and
readable in the dashboard. `wrangler secret put` is the only correct home.

## Token scope

Metadata: read + Administration: read, all repositories. Administration is
broader than it sounds: read access to repo settings and webhook configuration
across the fleet. It is required for the traffic endpoints and there is no
narrower option. No Contents scope, so Clio cannot read code.

## The Access boundary

`REQUIRE_ACCESS` defaults to `"1"`. The Worker refuses any request lacking
`Cf-Access-Authenticated-User-Email` or `Cf-Access-Jwt-Assertion`, so a
misconfigured route cannot expose data — the failure mode is a 403, not a leak.

A presence check would normally be weak, since a client could send the header
itself. It holds here because **Cloudflare strips client-supplied `Cf-*` headers
at the edge**, verified by sending a forged header from outside and still getting
403. Validating the `Cf-Access-Jwt-Assertion` signature against the team's public
keys is still strictly better, and is the right upgrade if this Worker ever
becomes reachable by a path that does not traverse Cloudflare.

Defining a route in `wrangler.toml` disables workers.dev, which matters: a
workers.dev URL is **not** covered by an Access application scoped to the custom
hostname, and would be an uncontrolled second entrance.

`/healthz` is intentionally exempt from the Worker's own check — but once Access
covers the hostname it is gated anyway, so it needs an Access bypass policy to be
usable for uptime monitoring.

## Repository hygiene

No tailnet hostnames, no tailnet or RFC1918 addresses, no account identifiers in
tracked files. Topology in tracked files was the largest exposure class in a prior
fleet-wide audit — not credentials, but inventory. Before committing:

```
grep -rn -E 'ts\.net|100\.[0-9]+\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+' \
  --exclude-dir=node_modules --exclude-dir=.wrangler .
```

The D1 `database_id` in `wrangler.toml` is committed deliberately. It is an
identifier, not a secret, and deploys need it.

## Zero Trust org objects replace, not patch

`PUT /accounts/{id}/access/organizations` replaces the whole object. Sending one
field blanks the rest — including `auth_domain`, which would break the team
domain. `tools/zt-warp-flag.sh` does read-modify-write for this reason. Treat any
Cloudflare org-level PUT as replace-semantics until proven otherwise.
