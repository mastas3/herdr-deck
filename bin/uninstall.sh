#!/bin/bash
# Stops herdr-deck, removes the login service and its tailnet address. Your data in ~/.config/herdr-deck is kept.
PORT_TS="${DECK_TS_PORT:-8448}"
if [ "$(uname)" = "Darwin" ]; then
  LABEL="dev.herdr-deck"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "stopped"
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" && echo "removed login service"
else
  systemctl --user disable --now herdr-deck.service 2>/dev/null && echo "stopped"
  rm -f "$HOME/.config/systemd/user/herdr-deck.service" && systemctl --user daemon-reload 2>/dev/null && echo "removed login service"
fi
if command -v tailscale >/dev/null && tailscale serve status 2>/dev/null | grep -q ":$PORT_TS"; then
  tailscale serve --https="$PORT_TS" off >/dev/null 2>&1 && echo "removed tailnet address on :$PORT_TS"
fi
echo "your data is still in ~/.config/herdr-deck (delete that folder to remove it too)"
