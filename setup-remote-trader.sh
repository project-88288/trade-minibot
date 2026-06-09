#!/usr/bin/env bash
# Deploy ftrade-bot to the remote Linux device and install it as a systemd service.
#
# Usage:  ./setup-remote-trader.sh [user@host]
# Default host: opzlabs.com
#
# Prerequisites:
#   - SSH key access to the remote host
#   - Node.js 18+ installed on the remote host
#   - sudo access on the remote host (for systemd)
#
# After setup:
#   1. scp .env user@host:~/remote-trader/.env
#   2. ssh user@host 'sudo systemctl start ftrade-bot'
#   3. ssh user@host 'journalctl -u ftrade-bot -f'

set -euo pipefail

REMOTE="${1:-opzlabs.com}"
SERVICE="ftrade-bot"

echo "==> Syncing files to $REMOTE:~/remote-trader"
ssh "$REMOTE" 'mkdir -p ~/remote-trader'
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='logs' \
  ./ "$REMOTE:~/remote-trader/"

echo "==> Installing npm dependencies"
ssh "$REMOTE" 'cd ~/remote-trader && npm install --omit=optional'

echo "==> Installing systemd service"
ssh "$REMOTE" 'bash -s' << 'REMOTE_SCRIPT'
set -e
REMOTE_DIR=$(realpath ~/remote-trader)
SERVICE=ftrade-bot
NODE_BIN=$(which node 2>/dev/null || echo /usr/bin/node)

cat > /tmp/"$SERVICE".service << UNIT
[Unit]
Description=ftrade-bot live trading service
After=network.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
ExecStart=$NODE_BIN $REMOTE_DIR/bot.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
EnvironmentFile=$REMOTE_DIR/.env

[Install]
WantedBy=multi-user.target
UNIT

sudo mv /tmp/"$SERVICE".service /etc/systemd/system/"$SERVICE".service
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
echo "Service '$SERVICE' installed and enabled."
REMOTE_SCRIPT

echo ""
echo "==> Done. Next steps:"
echo "    1. Copy your .env:     scp .env $REMOTE:~/remote-trader/.env"
echo "    2. Start the bot:      ssh $REMOTE 'sudo systemctl start $SERVICE'"
echo "    3. Follow logs:        ssh $REMOTE 'journalctl -u $SERVICE -f'"
echo "    4. Run a backtest:     ssh $REMOTE 'cd ~/remote-trader && node bot.js --backtest'"
echo "    5. Redeploy:           re-run this script (service restarts automatically)"
