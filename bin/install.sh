#!/bin/bash
# Installs herdr-deck as a login service (launchd) on http://127.0.0.1:${DECK_PORT:-4747}.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
PORT="${DECK_PORT:-4747}"
LABEL="dev.herdr-deck"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/herdr-deck.log"

[ -x "$BUN" ] || { echo "bun not found; install it from https://bun.sh" >&2; exit 1; }

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$DIR/src/server.ts</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>DECK_PORT</key><string>$PORT</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && { echo "herdr-deck running on http://127.0.0.1:$PORT (log: $LOG)"; exit 0; }
  sleep 0.25
done
echo "service installed but not answering yet; check $LOG" >&2
exit 1
