#!/usr/bin/env bash
# Install ftrade-bot as a macOS LaunchAgent.
# The service restarts automatically (KeepAlive: true — see bot.js's
# midnight restart) but does NOT auto-start on login — run
# "launchctl start <label>" when ready. The label is derived from this
# folder's name plus the OPTIMIZER_URL in .env (see service-label.sh), so
# multiple checkouts can run as separate services.
#
# Usage:  ./setup-service-mc.sh
#
# Prerequisites:
#   - Node.js 18+ (brew install node  or  nvm)
#   - .env configured (see .env.example)
#
# After setup, this script prints the exact start/stop/logs commands for
# this instance's label.

set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/service-label.sh"
echo "==> Service label: $SERVICE_LABEL"

# ── Node.js check ─────────────────────────────────────────────────────────────
NODE_BIN=$(command -v node 2>/dev/null || echo "")
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found. Install it with:  brew install node"
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if (( NODE_MAJOR < 18 )); then
  echo "ERROR: Node.js 18+ required (found $(node --version))."
  exit 1
fi
echo "==> Node.js $(node --version) at $NODE_BIN"

# ── npm install ───────────────────────────────────────────────────────────────
echo "==> Installing npm dependencies"
(cd "$BOT_DIR" && npm install --omit=optional)

# ── .env check ────────────────────────────────────────────────────────────────
if [[ ! -f "$BOT_DIR/.env" ]]; then
  cp "$BOT_DIR/.env.example" "$BOT_DIR/.env"
  echo ""
  echo "WARNING: .env not found — copied from .env.example."
  echo "         Edit $BOT_DIR/.env and fill in your credentials before starting."
  echo ""
fi

# ── Log directory ─────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"

# ── Unload if already registered ─────────────────────────────────────────────
if launchctl list 2>/dev/null | grep -q "$SERVICE_LABEL"; then
  echo "==> Unloading existing service"
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# ── Write plist ───────────────────────────────────────────────────────────────
echo "==> Writing $PLIST_PATH"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${BOT_DIR}/bot.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${BOT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/err.log</string>

  <!-- Restart on crash AND on clean exit — bot.js exits with code 0 at
       midnight to pick up a fresh .env / optimizer fetch on restart. -->
  <key>KeepAlive</key>
  <true/>

  <!-- Do not start automatically at login — start manually when ready. -->
  <key>RunAtLoad</key>
  <false/>

  <!-- Minimum seconds between restarts to avoid rapid crash loops. -->
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLIST

# ── Load the service ──────────────────────────────────────────────────────────
echo "==> Loading LaunchAgent"
launchctl load "$PLIST_PATH"

echo ""
echo "==> Done. ftrade-bot is installed as a macOS service."
echo ""
echo "    Start   :  launchctl start  $SERVICE_LABEL"
echo "    Stop    :  launchctl stop   $SERVICE_LABEL"
echo "    Status  :  launchctl list | grep $SERVICE_LABEL"
echo "    Stdout  :  tail -f $LOG_DIR/out.log"
echo "    Stderr  :  tail -f $LOG_DIR/err.log"
echo "    Remove  :  ./remove-service-mc.sh"
