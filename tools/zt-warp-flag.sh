#!/usr/bin/env bash
# Read or set the Zero Trust organization flag allow_authenticate_via_warp.
#
# That flag is account-wide. When true with no WARP session duration configured,
# every Access application save fails validation with:
#   access.api.error.invalid_request: allow_authenticate_via_warp cannot be set
#   if the Warp Auth Session Duration is not set for the account
#
# Needs an API token with: Account -> Access: Organizations -> Edit
#   My Profile -> API Tokens -> Create Token -> Custom token
#
# Usage:
#   ./tools/zt-warp-flag.sh get
#   ./tools/zt-warp-flag.sh set false
#   ./tools/zt-warp-flag.sh duration 24h
#
# The token is prompted for, never echoed, and never stored.
set -euo pipefail

ACTION="${1:-get}"
VALUE="${2:-false}"

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$ACCOUNT_ID" ]; then
  ACCOUNT_ID=$(npx --no-install wrangler whoami 2>/dev/null \
    | grep -Eo '[0-9a-f]{32}' | head -1 || true)
fi
if [ -z "$ACCOUNT_ID" ]; then
  echo "Could not determine account id. Set CLOUDFLARE_ACCOUNT_ID and retry." >&2
  exit 1
fi
echo "account id resolved (${#ACCOUNT_ID} chars)"

printf 'Cloudflare API token (input hidden): '
read -rs TOKEN
printf '\n'
[ -z "$TOKEN" ] && { echo "no token entered" >&2; exit 1; }

API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/organizations"

if [ "$ACTION" = "duration" ]; then
  # Sets warp_auth_session_duration on the org. The Access application validator
  # refuses allow_authenticate_via_warp when this is null, which is the whole
  # cause of "Warp Auth Session Duration is not set for the account". Read the
  # current object, merge this one field, write it back.
  CUR=$(curl -s -X GET "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
  BODY=$(printf '%s' "$CUR" | DUR="$VALUE" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
if not d.get('success'):
    print('FAILED reading current org:', json.dumps(d.get('errors')), file=sys.stderr)
    raise SystemExit(1)
r = d['result']
keep = {k: r[k] for k in ('auth_domain','name','session_duration',
        'auto_redirect_to_identity','is_ui_read_only','allow_authenticate_via_warp') if k in r}
keep['warp_auth_session_duration'] = os.environ['DUR']
print(json.dumps(keep))
") || exit 1
  echo "  setting warp_auth_session_duration = $VALUE"
  curl -s -X PUT "$API" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "$BODY" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('success'):
    r = d.get('result') or {}
    print('  ok. warp_auth_session_duration =', r.get('warp_auth_session_duration'))
    print('      allow_authenticate_via_warp =', r.get('allow_authenticate_via_warp'))
    print('      auth_domain still =', r.get('auth_domain'))
else:
    print('FAILED:', json.dumps(d.get('errors'), indent=2)); raise SystemExit(1)
"
elif [ "$ACTION" = "get" ]; then
  curl -s -X GET "$API" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'):
    print('FAILED:', json.dumps(d.get('errors'), indent=2)); raise SystemExit(1)
r=d.get('result') or {}
for k in ('name','auth_domain','allow_authenticate_via_warp',
          'warp_auth_session_duration','session_duration'):
    if k in r: print(f'  {k} = {r[k]}')
"
else
  # This endpoint REPLACES the organization object - it is not a patch. Omitting
  # auth_domain blanks the team domain and the API rejects it with
  # invalid_auth_domain. So: read current state, merge one field, write it back.
  CUR=$(curl -s -X GET "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
  BODY=$(printf '%s' "$CUR" | VALUE="$VALUE" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
if not d.get('success'):
    print('FAILED reading current org:', json.dumps(d.get('errors')), file=sys.stderr)
    raise SystemExit(1)
r = d['result']
want = os.environ['VALUE'].lower() == 'true'
keep = {k: r[k] for k in ('auth_domain','name','session_duration',
        'auto_redirect_to_identity','is_ui_read_only') if k in r}
keep['allow_authenticate_via_warp'] = want
print(json.dumps(keep))
") || exit 1
  echo "  merging into existing org object (preserving auth_domain)"
  curl -s -X PUT "$API" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "$BODY" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('success'):
    r = d.get('result') or {}
    print('  updated. allow_authenticate_via_warp =', r.get('allow_authenticate_via_warp'))
    print('  auth_domain still =', r.get('auth_domain'))
else:
    print('FAILED:', json.dumps(d.get('errors'), indent=2)); raise SystemExit(1)
"
fi
unset TOKEN
