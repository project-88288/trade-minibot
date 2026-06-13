#!/usr/bin/env bash
# Stop and unregister the ftrade-bot macOS LaunchAgent.
# Does NOT delete the bot files or .env.
#
# Usage:  ./remove-service-mc.sh

set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/service-label.sh"

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
