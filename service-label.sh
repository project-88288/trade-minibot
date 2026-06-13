#!/usr/bin/env bash
# Shared LaunchAgent label derivation, sourced by setup-service-mc.sh,
# remove-service-mc.sh, and status.sh so they all agree on the same service.
#
# The label is namespaced by folder name + exchange + symbol + optimizer URL
# so multiple ftrade-bot checkouts (different pairs/exchanges/optimizers) can
# run as separate LaunchAgents on the same machine without colliding.

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOLDER_NAME="$(basename "$BOT_DIR")"

_env_var() {
  grep -E "^$1=" "$BOT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]'
}

SYMBOL="$(_env_var SYMBOL)"
SYMBOL="${SYMBOL:-BTCUSDT}"

EXCHANGE="$(_env_var EXCHANGE)"
EXCHANGE="${EXCHANGE:-binance}"

OPTIMIZER_URL="$(_env_var OPTIMIZER_URL)"
OPTIMIZER_URL="${OPTIMIZER_URL:-http://localhost:4500}"
OPTIMIZER_HOST="$(echo "$OPTIMIZER_URL" | sed -E 's#^[a-zA-Z]+://##; s#[^a-zA-Z0-9]+#-#g; s/-$//')"

SERVICE_LABEL="com.ftrade-bot.${FOLDER_NAME}.${EXCHANGE}.${SYMBOL}.${OPTIMIZER_HOST}"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/ftrade-bot-${FOLDER_NAME}"
