#!/bin/bash
# One-line install for herdr deck:
#   curl -fsSL https://raw.githubusercontent.com/mastas3/herdr-deck/main/bin/bootstrap.sh | bash
# Gets Bun if it's missing, puts the deck in ~/.local/share/herdr-deck (or updates it there), and starts it
# as a login service with bin/install.sh. Run it again any time to update.
#   DECK_DIR=...        where the deck lives (default ~/.local/share/herdr-deck)
#   DECK_REPO=...       git URL to install from
#   DECK_REF=main       branch or tag
#   DECK_NO_BUN=1       don't install Bun automatically
# Everything bin/install.sh understands (DECK_PORT, DECK_NO_TAILSCALE…) is passed through.
set -euo pipefail
REPO="${DECK_REPO:-https://github.com/mastas3/herdr-deck.git}"
REF="${DECK_REF:-main}"
DIR="${DECK_DIR:-$HOME/.local/share/herdr-deck}"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname)" in Darwin|Linux) ;; *) die "herdr deck runs on macOS and Linux only." ;; esac
command -v git >/dev/null || die "git is missing. macOS: run 'xcode-select --install'. Linux: install git with your package manager."
command -v curl >/dev/null || die "curl is missing; install it with your package manager."

# Bun runs the deck (no other dependencies, no build step).
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null; then
  [ -z "${DECK_NO_BUN:-}" ] || die "bun is missing; install it from https://bun.sh"
  command -v unzip >/dev/null || die "Bun's installer needs unzip; install it with your package manager, then run this again."
  say "Installing Bun (https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  command -v bun >/dev/null || die "Bun didn't install; see https://bun.sh"
fi

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" fetch --quiet origin "$REF"
  git -C "$DIR" checkout --quiet "$REF"
  git -C "$DIR" merge --quiet --ff-only "origin/$REF" || die "$DIR has local changes; update it by hand (git -C $DIR pull)."
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR already exists and isn't a git checkout. Move it away or set DECK_DIR to another folder."
else
  say "Downloading herdr deck to $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --branch "$REF" "$REPO" "$DIR"
fi

say "Starting the deck as a login service"
"$DIR/bin/install.sh"

if ! command -v herdr >/dev/null && [ ! -x /opt/homebrew/bin/herdr ]; then
  echo
  echo "Next: install herdr, the terminal the deck watches:  brew install herdr   (or see https://herdr.dev)"
  echo "Then start it with 'herdr' and run your agents inside it. The deck picks it up by itself."
fi
echo
echo "Open http://127.0.0.1:${DECK_PORT:-4747} in your browser."
