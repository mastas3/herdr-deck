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

# Phones and other machines reach the deck over HTTPS on the tailnet (never Funnel). Session links use that address.
TS="$(command -v tailscale || true)"
TS_PORT="${DECK_TS_PORT:-8448}"
PUBLIC_URL="${DECK_PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ] && [ -n "$TS" ] && "$TS" status >/dev/null 2>&1; then
  NAME="$("$TS" status --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  PUBLIC_URL="https://$NAME:$TS_PORT"
fi

OLD_SUM="$(shasum "$PLIST" 2>/dev/null || true)"
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
    <key>DECK_PUBLIC_URL</key><string>$PUBLIC_URL</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

# Already loaded with the same definition: restart in place. A changed definition (new env, paths) needs a
# reload, because kickstart keeps the old one; bootstrap right after bootout can race launchd (EIO), so retry.
DOMAIN="gui/$(id -u)"
LOADED="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null || true)"
if [ -n "$LOADED" ] && [ "$OLD_SUM" = "$(shasum "$PLIST")" ] && grep -q "DECK_PUBLIC_URL => $PUBLIC_URL\$" <<<"$LOADED"; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
else
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  for i in 1 2 3 4 5 6 7 8; do launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break; sleep 1; done
fi
up=""
for _ in $(seq 1 100); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && { up=1; break; }
  sleep 0.25
done
[ -n "$up" ] || { echo "service installed but not answering yet; check $LOG" >&2; exit 1; }
echo "herdr-deck running on http://127.0.0.1:$PORT (log: $LOG)"

# The tailnet proxy to the loopback port. The server itself only lets in the machine owner's Tailscale login.
if [ -n "$TS" ] && [ -n "$PUBLIC_URL" ] && "$TS" status >/dev/null 2>&1; then
  "$TS" serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT" >/dev/null
  echo "on your tailnet: $PUBLIC_URL  (open it on your phone and add it to the home screen)"
fi
