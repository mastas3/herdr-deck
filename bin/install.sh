#!/bin/bash
# Installs herdr-deck as a login service on http://127.0.0.1:${DECK_PORT:-4747}, restarting it if it's already there.
#   macOS: a launchd agent (dev.herdr-deck).  Linux: a systemd --user service (herdr-deck).
# Safe to run again after an update: it restarts the service in place.
#   DECK_PORT=4747         loopback port
#   DECK_TS_PORT=8448      tailnet HTTPS port (when Tailscale is running)
#   DECK_PUBLIC_URL=...    the address session links use (defaults to the tailnet address)
#   DECK_NO_TAILSCALE=1    don't touch Tailscale
# Other settings live in ~/.config/herdr-deck/env (see the README).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
PORT="${DECK_PORT:-4747}"
OS="$(uname)"
# Your own settings (DECK_BRIEF_MODEL=…, one per line) go here; restart the service (run this again) after editing.
ENV_FILE="$HOME/.config/herdr-deck/env"

[ -x "$BUN" ] || { echo "bun not found; install it with: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; }
command -v herdr >/dev/null || [ -x /opt/homebrew/bin/herdr ] || [ -x "$HOME/.local/bin/herdr" ] ||
  echo "note: herdr isn't installed yet (https://herdr.dev). The deck will start, but it has nothing to show until herdr runs." >&2

# Phones and other machines reach the deck over HTTPS on the tailnet (never Funnel). Session links use that address.
TS=""
[ -n "${DECK_NO_TAILSCALE:-}" ] || TS="$(command -v tailscale || true)"
TS_PORT="${DECK_TS_PORT:-8448}"
PUBLIC_URL="${DECK_PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ] && [ -n "$TS" ] && "$TS" status >/dev/null 2>&1; then
  NAME="$("$TS" status --json | "$BUN" -e 'console.log(JSON.parse(await Bun.stdin.text()).Self.DNSName.replace(/\.$/, ""))')"
  PUBLIC_URL="https://$NAME:$TS_PORT"
fi

if [ "$OS" = "Darwin" ]; then
  LABEL="dev.herdr-deck"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG="$HOME/Library/Logs/herdr-deck.log"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  OLD_SUM="$(shasum "$PLIST" 2>/dev/null || true)"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>--env-file=$ENV_FILE</string><string>$DIR/src/server.ts</string></array>
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
elif [ "$OS" = "Linux" ]; then
  command -v systemctl >/dev/null || { echo "systemd not found; run the deck by hand instead: bun $DIR/src/server.ts" >&2; exit 1; }
  LOG="journalctl --user -u herdr-deck"
  UNIT="$HOME/.config/systemd/user/herdr-deck.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UNIT
[Unit]
Description=herdr deck
After=default.target

[Service]
ExecStart=$BUN --env-file=$ENV_FILE $DIR/src/server.ts
WorkingDirectory=$DIR
Environment=DECK_PORT=$PORT
Environment=DECK_PUBLIC_URL=$PUBLIC_URL
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable herdr-deck.service >/dev/null 2>&1
  systemctl --user restart herdr-deck.service
  # Without lingering, systemd stops user services at logout.
  if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
    echo "tip: to keep the deck running after you log out: sudo loginctl enable-linger $USER"
  fi
else
  echo "unsupported system: $OS (macOS and Linux only)" >&2; exit 1
fi

up=""
for _ in $(seq 1 100); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && { up=1; break; }
  sleep 0.25
done
[ -n "$up" ] || { echo "service installed but not answering yet; check: $LOG" >&2; exit 1; }
echo "herdr-deck running on http://127.0.0.1:$PORT (log: $LOG)"

# The tailnet proxy to the loopback port. The server itself only lets in the machine owner's Tailscale login.
if [ -n "$TS" ] && [ -n "$PUBLIC_URL" ] && "$TS" status >/dev/null 2>&1; then
  if "$TS" serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    echo "on your tailnet: $PUBLIC_URL  (open it on your phone and add it to the home screen)"
  else
    echo "couldn't run 'tailscale serve' (on Linux: sudo tailscale set --operator=\$USER, then run this again)" >&2
  fi
fi
