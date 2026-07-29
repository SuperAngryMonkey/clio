# ADR 0004 — Cloudflare Access as the authentication boundary

**Status:** accepted, 2026-07-29 (Cloudflare branch)

## Context

The LXC deployment used HTTP Basic Auth against a scrypt hash. On a tailnet-only
host that was adequate. On a public hostname it is not: the dashboard is reachable
from anywhere, and a browser credential prompt is both unpleasant and unbranded.

Three options: keep Basic Auth, build a login form in the Worker, or put
Cloudflare Access in front.

## Decision

Cloudflare Access, free for up to 50 users. One self-hosted application, one Allow
policy on a single email, one-time PIN as the login method.

The Worker additionally refuses any request lacking `Cf-Access-Authenticated-User-Email`
or `Cf-Access-Jwt-Assertion`, controlled by `REQUIRE_ACCESS` which **defaults to
on**. A misconfigured route therefore fails closed with a 403 rather than serving
data.

## Why a header presence check is sufficient here

Normally this would be trivially bypassable — any client can send a header. It
holds because **Cloudflare strips client-supplied `Cf-*` headers at the edge**.
Verified empirically: a request with a forged `Cf-Access-Authenticated-User-Email`
from outside still received 403.

Signature-verifying the `Cf-Access-Jwt-Assertion` against the team's public keys
is strictly stronger and remains the correct upgrade if the Worker ever becomes
reachable by a path that does not traverse Cloudflare.

## Alternatives rejected

**A login form in the Worker.** Full visual control — the login page could match
the dashboard's theme exactly, which Access cannot (logo, colours and message text
only, on a cloudflareaccess.com domain). Rejected because it means owning password
hashing, signed session cookies, expiry, rate limiting and lockout, on a public
hostname that gets scanned. Not worth it for one user.

**Keeping Basic Auth.** No branded page, credentials on every request, and a
password to rotate by hand.

## Consequences

There is no password anywhere in the deployment.

`/healthz` is gated too, so external uptime monitoring needs an Access bypass
policy for that path.

Defining a route in `wrangler.toml` disables workers.dev — which is load-bearing,
not incidental. An Access application scoped to the custom hostname does **not**
cover a workers.dev URL, so leaving it enabled would be an uncontrolled second
entrance.

Setting Access up cost more time than the code it protects, entirely in two
Cloudflare-side traps: an organization-level WARP flag with a missing prerequisite,
and a zone-wide redirect rule pre-empting the Worker route. Both documented in
`SETUP-CLOUDFLARE.md`.
