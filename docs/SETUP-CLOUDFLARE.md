# Cloudflare setup

Reproducing Clio on Cloudflare from nothing. Steps 1-5 are wrangler; 6-7 are the
Zero Trust dashboard. Both gotcha sections cost real time the first time round.

## Prerequisites

- A Cloudflare account with a zone you control (referred to below as `example.com`)
- `npm install` in this repo (brings wrangler in as a devDependency)
- `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` in the environment
- A fine-grained GitHub PAT: **Metadata: read** + **Administration: read**,
  All repositories. Administration is what unlocks the traffic endpoints.
  Clio has no Contents scope and cannot read code.

Minimum OAuth scopes for deploys: `workers_scripts:write`, `workers_routes:write`,
`d1:write`, `zone:read`. Note `zone:read` is enough for a Worker custom domain —
that goes through the routes API, not DNS edit.

## 1. Create the D1 database

```
npx wrangler d1 create clio
```

Copy the returned `database_id` into `wrangler.toml` under `[[d1_databases]]`.
The id is an identifier, not a credential; it is useless without account auth.

## 2. Apply the schema

```
npx wrangler d1 migrations apply clio --remote
```

Confirm 9 tables (plus D1's own `_cf_KV`, `d1_migrations`, `sqlite_sequence`):

```
npx wrangler d1 execute clio --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

## 3. Set the GitHub token as a secret

```
npx wrangler secret put GITHUB_TOKEN
```

Prompted, not echoed, never written to the repo. Never put this in `[vars]` —
vars are plaintext in the deployed config and visible in the dashboard.

## 4. Deploy

```
npx wrangler deploy
```

This registers the cron trigger and attaches the custom domain from `routes`.

Note: defining any route causes wrangler to **disable workers.dev by default**.
That is desirable — it leaves exactly one entry point, the one Access guards,
rather than a second unadvertised URL that Access does not cover.

## 5. Verify collection

The scheduled handler does not pass through `fetch()`, so it runs regardless of
Access. Wait for a cron tick, then:

```
npx wrangler d1 execute clio --remote \
  --command "SELECT id,finished,ok,repos_synced,api_calls,slice_from,slice_to,error \
             FROM sync_runs ORDER BY id DESC LIMIT 3"
```

`ok=1` with `api_calls` in the low 40s is a healthy slice. See DESIGN.md for why
it is a slice and not the whole fleet.

## 6. Zero Trust / Access

1. **Zero Trust → Settings**: create a team name. It becomes
   `<team>.cloudflareaccess.com` and is where the login handshake lands.
   Cloudflare requires a payment method on file even for the free 50-user tier.
   Dashboard SSO blocks team-domain changes later, so choose the name deliberately.
2. **Settings → Authentication → Login methods**: One-time PIN is enabled by
   default and needs no identity provider. Google or GitHub SSO both require
   registering an OAuth app.
3. **Access → Applications → Add → Self-hosted**
   - Application domain: the Worker's hostname
   - Session duration: long. You are the only user, and forcing constant
     re-authentication is how people end up disabling security.
4. **Policy**: one rule, action Allow, selector Emails, value your address.
   Everything else on the internet gets the login page and nothing behind it.
5. **Settings → Custom Pages → Access login page**: logo, background colour and
   message text are customisable. That is the extent of it — the page is not
   fully themeable and stays on the cloudflareaccess.com domain.

### Gotcha: allow_authenticate_via_warp

Saving the application may fail with:

```
access.api.error.invalid_request: allow_authenticate_via_warp cannot be set
if the Warp Auth Session Duration is not set for the account
```

`warp_auth_session_duration` is null on the **organization** object, and the
validator refuses the WARP option without it. Hunting for the toggle is a dead
end; set the missing field instead:

```
./tools/zt-warp-flag.sh get           # confirm it is absent
./tools/zt-warp-flag.sh duration 24h  # set it
```

Needs a token with **Account → Access: Organizations → Edit**.

Two things to know about that endpoint. It **replaces** the organization object
rather than patching it, so omitting `auth_domain` blanks the team domain — the
tool does read-modify-write for this reason. And if WARP auth is ever actually
enabled, the client session duration **takes precedence over application, policy
and global** durations, so a 24h value here would override a longer app session.

### Gotcha: zone-wide redirect rules pre-empt Workers

A Redirect Rule or Page Rule matching the zone broadly (`*example.com/*`, or a
`contains` expression on hostname) will intercept the Worker's hostname. Redirect
rules run **earlier in the request pipeline than Worker routes**, so the Worker
is never invoked and the symptom looks like a broken deployment.

Diagnose:

```
curl -sI https://<worker-hostname>/ | grep -iE '^(HTTP/|location:|server:)'
```

`server: cloudflare` on a 302 means the redirect is Cloudflare's, not an origin's.
Then narrow the rule to an exact host match:

```
http.host eq "example.com"
```

`./tools/cf-redirect-scope.sh` lists Page Rules and Redirect Rules for a zone
read-only, so the offending rule can be found before anything is changed.

Prefer 302 over 301 for such redirects. A 301 is cached semi-permanently by
browsers, so a mistake follows you onto every device that ever hit the URL.

## 7. Confirm the whole chain

```
curl -sI https://<worker-hostname>/ | grep -i location
```

A 302 to `<team>.cloudflareaccess.com/cdn-cgi/access/login/...` means Access is in
front of the Worker. The `meta` query parameter is a readable JWT payload —
decode it to see `hostname`, `auth_status` and `is_warp`. That is the fastest way
to see what Access believes is happening rather than what you assume.

curl only ever sees the redirect. Use a browser for the actual login flow.

## Notes

- `/healthz` is also behind Access once the application covers the hostname, so
  it is not usable for external uptime monitoring without a bypass policy.
- Cron Triggers have **no retries and no failure alerting**. A failed scheduled
  run is simply gone until the next tick. `sync_runs` is the only record; check it
  after any token rotation.
- Fine-grained GitHub PATs expire, and expiry is silent — the cron keeps firing
  and the sync keeps failing.
