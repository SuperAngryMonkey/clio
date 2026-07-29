#!/usr/bin/env bash
# Inspect the redirect rules on a zone, so an over-broad host pattern can be
# found before anything is changed.
#
# Why this exists: a rule matching *example.com/* catches every subdomain and
# runs BEFORE Worker routes in the request pipeline, so it pre-empts any service
# hosted on the zone. Narrowing it to the apex keeps the shortcut working.
#
# Token needs (read-only is enough to list):
#   Zone -> Zone: Read
#   Zone -> Page Rules: Read
#   Zone -> Dynamic Redirect: Read
#     My Profile -> API Tokens -> Create Token -> Custom token
#
# Usage:  ./tools/cf-redirect-scope.sh [zone-name]
set -euo pipefail
ZONE_NAME="${1:-example.com}"

printf 'Cloudflare API token (input hidden): '
read -rs TOKEN
printf '\n'
[ -z "$TOKEN" ] && { echo "no token entered" >&2; exit 1; }
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

ZID=$(curl -s "${H[@]}" "https://api.cloudflare.com/client/v4/zones?name=$ZONE_NAME" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'): print('FAILED:', json.dumps(d.get('errors')), file=sys.stderr); raise SystemExit(1)
r=d.get('result') or []
if not r: print('zone not found', file=sys.stderr); raise SystemExit(1)
print(r[0]['id'])")
echo "zone $ZONE_NAME resolved"

echo
echo "=== PAGE RULES (legacy) ==="
curl -s "${H[@]}" "https://api.cloudflare.com/client/v4/zones/$ZID/pagerules" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'):
    print('  cannot read page rules:', json.dumps(d.get('errors'))); raise SystemExit(0)
rules=d.get('result') or []
if not rules: print('  (none)')
for r in rules:
    tgt=[c['constraint']['value'] for c in r.get('targets',[]) if c.get('constraint')]
    acts=[(a.get('id'), (a.get('value') or {}).get('url') if isinstance(a.get('value'),dict) else a.get('value')) for a in r.get('actions',[])]
    print(f\"  id={r['id']}\")
    print(f\"    status  = {r.get('status')}\")
    print(f\"    match   = {tgt}\")
    print(f\"    actions = {acts}\")
"

echo
echo "=== REDIRECT RULES (http_request_dynamic_redirect) ==="
curl -s "${H[@]}" "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'):
    print('  cannot read rulesets:', json.dumps(d.get('errors'))); raise SystemExit(0)
for rs in d.get('result') or []:
    if rs.get('phase')=='http_request_dynamic_redirect':
        print(f\"  ruleset id={rs['id']}  name={rs.get('name')}\")
" > /tmp/.clio_rs
cat /tmp/.clio_rs
RSID=$(grep -Eo 'id=[0-9a-f]{32}' /tmp/.clio_rs | head -1 | cut -d= -f2 || true)
if [ -n "${RSID:-}" ]; then
  curl -s "${H[@]}" "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/$RSID" \
    | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'):
    print('  cannot read ruleset:', json.dumps(d.get('errors'))); raise SystemExit(0)
for r in (d['result'].get('rules') or []):
    print(f\"  rule id={r['id']}  enabled={r.get('enabled')}\")
    print(f\"    expression = {r.get('expression')}\")
    frm=(r.get('action_parameters') or {}).get('from_value') or {}
    tv=frm.get('target_url') or {}
    print(f\"    redirect   = {tv.get('value') or tv.get('expression')}  status={frm.get('status_code')}\")
"
else
  echo "  (no dynamic redirect ruleset - so it is a Page Rule)"
fi
unset TOKEN
