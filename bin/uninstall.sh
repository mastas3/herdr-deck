#!/bin/bash
# Stops herdr-deck and removes the login service. The Closed list in ~/.config/herdr-deck is kept.
LABEL="dev.herdr-deck"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "stopped"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" && echo "removed login service"
