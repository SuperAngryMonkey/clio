#!/bin/sh
# The systemd build uses a timer. Compose has no timer, so the collector runs
# in a loop instead of being restarted -- restart-as-schedule would mask a
# crash-loop as normal operation.
set -eu
INTERVAL="${CLIO_INTERVAL_SECONDS:-10800}"
echo "clio collector: every ${INTERVAL}s"
while true; do
  START=$(date -u +%s)
  if python3 /app/collector.py; then
    echo "clio collector: run ok"
  else
    echo "clio collector: run FAILED (exit $?), continuing" >&2
  fi
  ELAPSED=$(( $(date -u +%s) - START ))
  SLEEP=$(( INTERVAL - ELAPSED ))
  [ "$SLEEP" -lt 30 ] && SLEEP=30
  sleep "$SLEEP"
done
