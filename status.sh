#!/usr/bin/env bash
# Check whether ftrade-bot LaunchAgent is running or stopped.

source "$(cd "$(dirname "$0")" && pwd)/service-label.sh"

# ── launchctl row ─────────────────────────────────────────────────────────────
ROW=$(launchctl list 2>/dev/null | grep "$SERVICE_LABEL" || true)

if [[ -z "$ROW" ]]; then
  echo "STATUS: NOT LOADED  (service is not registered with launchctl)"
  exit 1
fi

# Row format:  PID   LastExitCode   Label
PID=$(echo "$ROW" | awk '{print $1}')
EXIT_CODE=$(echo "$ROW" | awk '{print $2}')

if [[ "$PID" != "-" && "$PID" =~ ^[0-9]+$ ]]; then
  echo "STATUS: RUNNING"
  echo "   PID        : $PID"
  echo "   Service    : $SERVICE_LABEL"
  echo "   Uptime     : $(ps -p "$PID" -o etime= 2>/dev/null | tr -d ' ' || echo 'unknown')"
else
  echo "STATUS: STOPPED"
  echo "   Service    : $SERVICE_LABEL"
  echo "   Last exit  : $EXIT_CODE"
fi

# ── last 5 log lines ─────────────────────────────────────────────────────────
if [[ -f "$LOG_DIR/out.log" ]]; then
  echo ""
  echo "--- last 5 lines of out.log ---"
  tail -n 5 "$LOG_DIR/out.log"
fi

if [[ -f "$LOG_DIR/err.log" ]]; then
  ERRSIZE=$(wc -c < "$LOG_DIR/err.log")
  if (( ERRSIZE > 0 )); then
    echo ""
    echo "--- last 5 lines of err.log ---"
    tail -n 5 "$LOG_DIR/err.log"
  fi
fi
