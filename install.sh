#!/usr/bin/env bash
# Clio - reproducible install on a fresh Debian 12 host.
# Run as root. Idempotent: safe to re-run.
set -euo pipefail

PGVER=15
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
SRC="$(cd "$(dirname "$0")" && pwd)"

update-locale LANG=C.UTF-8 >/dev/null 2>&1 || true
apt-get update -qq
apt-get install -y -qq postgresql python3 python3-psycopg2 python3-flask gunicorn curl ca-certificates

# The cluster MUST be UTF-8. Debian's default in a minimal container is locale C,
# which yields SQL_ASCII and rejects any non-ASCII byte. See docs/adr/0001.
ENC=$(su - postgres -c "psql -tAc \"SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname='template1'\"" || echo UNKNOWN)
if [ "$ENC" != "UTF8" ]; then
  echo "cluster is $ENC, recreating as C.UTF-8"
  pg_dropcluster --stop "$PGVER" main >/dev/null 2>&1 || true
  pg_createcluster --locale=C.UTF-8 --start "$PGVER" main
fi
systemctl enable postgresql >/dev/null 2>&1

id -u clio >/dev/null 2>&1 || useradd -r -m -d /opt/clio -s /bin/bash clio
su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='clio'\"" | grep -q 1 || su - postgres -c "createuser clio"
su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='clio'\"" | grep -q 1 || su - postgres -c "createdb -O clio clio"

install -o clio -g clio -m 755 "$SRC/collector.py" /opt/clio/collector.py
install -o clio -g clio -m 644 "$SRC/app.py"       /opt/clio/app.py
install -m 644 "$SRC/systemd/"*.service "$SRC/systemd/"*.timer /etc/systemd/system/
printf '.env\nwebauth\n*.log\n__pycache__/\n' > /opt/clio/.gitignore

if [ ! -f /opt/clio/.env ]; then
  install -o clio -g clio -m 600 "$SRC/.env.example" /opt/clio/.env
  echo "NOTE: put your GitHub PAT in /opt/clio/.env before the collector will run."
fi

install -o clio -g clio -m 644 "$SRC/schema.sql" /tmp/clio-schema.sql
su - clio -c "psql -d clio -q -f /tmp/clio-schema.sql"

# Web credentials: generated on-host. Plaintext goes to a root-only file and is
# never stored by the app - only the scrypt hash. See docs/SECURITY.md.
if [ ! -f /opt/clio/webauth ]; then
  python3 - <<'PYGEN'
import secrets, os
from werkzeug.security import generate_password_hash
pw = secrets.token_urlsafe(15)
open("/opt/clio/webauth","w").write("ghost:" + generate_password_hash(pw))
os.chmod("/opt/clio/webauth", 0o600)
open("/root/clio-credentials.txt","w").write("Clio dashboard\nUsername : ghost\nPassword : %s\n" % pw)
os.chmod("/root/clio-credentials.txt", 0o600)
PYGEN
  chown clio:clio /opt/clio/webauth
  echo "credentials written to /root/clio-credentials.txt"
fi

systemctl daemon-reload
systemctl enable --now clio-collector.timer
systemctl enable --now clio-web.service
echo "clio installed. dashboard on :8080"
