#!/bin/bash
# Installs or updates herdr-deck on another machine as a node, over SSH.
#   bin/deploy-node.sh <ssh-host> [port]
# The node listens on 127.0.0.1 only. The hub reaches it through an SSH tunnel and authenticates
# with the node's ~/.config/herdr-deck/api.token. Linux uses a systemd --user service, macOS uses launchd.
set -euo pipefail
HOST="${1:?usage: deploy-node.sh <ssh-host> [port]}"
PORT="${2:-4747}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

rsync -a --delete --exclude .git --exclude node_modules --exclude '*.log' "$DIR/" "$HOST:.local/share/herdr-deck/"

ssh -o BatchMode=yes "$HOST" PORT="$PORT" bash -s <<'REMOTE'
set -euo pipefail
APP="$HOME/.local/share/herdr-deck"
BUN="$(command -v bun || ls "$HOME/.bun/bin/bun" /usr/local/bin/bun 2>/dev/null | head -1)"
[ -x "$BUN" ] || { echo "bun is not installed on $(hostname)" >&2; exit 1; }
if [ "$(uname)" = "Linux" ]; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/herdr-deck.service" <<UNIT
[Unit]
Description=herdr deck node
After=default.target

[Service]
ExecStart=$BUN $APP/src/server.ts
WorkingDirectory=$APP
Environment=DECK_PORT=$PORT
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable herdr-deck.service >/dev/null 2>&1
  systemctl --user restart herdr-deck.service
else
  DECK_PORT="$PORT" "$APP/bin/install.sh" >/dev/null
fi
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 0.25; done
curl -s "http://127.0.0.1:$PORT/health" >/dev/null && echo "node up on $(hostname):$PORT" || { echo "node didn't start; see: journalctl --user -u herdr-deck -n 40" >&2; exit 1; }
REMOTE
