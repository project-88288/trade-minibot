#!/usr/bin/env bash
# Stop and unregister the ftrade-bot macOS LaunchAgent.
# Does NOT delete the bot files or .env.
#
# Usage:  ./remove-service.sh

set -euo pipefail

SERVICE_LABEL="com.ftrade-bot"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"

echo "==> Removing $SERVICE_LABEL"

if launchctl list 2>/dev/null | grep -q "$SERVICE_LABEL"; then
  launchctl stop   "$SERVICE_LABEL" 2>/dev/null || true
  launchctl unload "$PLIST_PATH"    2>/dev/null || true
  echo "    Service stopped and unloaded."
else
  echo "    Service not currently loaded — nothing to unload."
fi

if [[ -f "$PLIST_PATH" ]]; then
  rm "$PLIST_PATH"
  echo "    Plist removed: $PLIST_PATH"
fi

echo "==> Done."
