#!/usr/bin/env bash
# Stop and remove the ftrade-bot systemd service from the remote device.
# Does NOT delete ~/remote-trader files or the .env — those must be removed manually.
#
# Usage:  ./remove-remote-trader.sh [user@host]

set -euo pipefail

REMOTE="${1:-opzlabs.com}"
SERVICE="ftrade-bot"

echo "==> Removing $SERVICE from $REMOTE"
ssh "$REMOTE" 'bash -s' << 'REMOTE_SCRIPT'
set -e
SERVICE=ftrade-bot
sudo systemctl stop    "$SERVICE" 2>/dev/null || true
sudo systemctl disable "$SERVICE" 2>/dev/null || true
sudo rm -f /etc/systemd/system/"$SERVICE".service
sudo systemctl daemon-reload
echo "Service '$SERVICE' removed."
REMOTE_SCRIPT
