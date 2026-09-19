#!/bin/bash
# install-reward-guard.sh - set up the Reward Vault guard on Linux (Bazzite/KDE).
#
# Run as the user you want enforced (not with sudo):
#     bash install-reward-guard.sh
#
# Copies the agent to ~/.local/share/RewardGuard and installs a per-user systemd unit that
# starts with your graphical session and restarts if it stops. Everything lives under $HOME -
# no rpm-ostree layering, so this works fine on an immutable image like Bazzite.

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/RewardGuard"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_NAME="reward-guard.service"
LOG="$DEST/reward-guard.log"

command -v jq >/dev/null 2>&1 || { echo "jq is required but not found on PATH. Install it first."; exit 1; }

mkdir -p "$DEST" "$UNIT_DIR"

# Stop an existing instance so the new agent/config takes effect.
systemctl --user stop "$UNIT_NAME" 2>/dev/null || true

cp "$SRC/reward-guard.sh" "$DEST/reward-guard.sh"
chmod +x "$DEST/reward-guard.sh"

if [ -f "$DEST/reward-guard.config.json" ]; then
  echo "Config already present at $DEST/reward-guard.config.json - leaving it (edit there, or delete to reset)."
else
  cp "$SRC/reward-guard.config.json" "$DEST/reward-guard.config.json"
fi

sed -e "s#__SCRIPT__#$DEST/reward-guard.sh#g" "$SRC/reward-guard.service" > "$UNIT_DIR/$UNIT_NAME"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

echo ""
echo "Installed and started $UNIT_NAME"
echo "  Agent:  $DEST/reward-guard.sh"
echo "  Config: $DEST/reward-guard.config.json"
echo "  Log:    $LOG"
echo ""
echo "Watch log:      tail -f \"$LOG\""
echo "Watch journal:  journalctl --user -u $UNIT_NAME -f"
echo "Uninstall:      systemctl --user disable --now $UNIT_NAME; rm -f \"$UNIT_DIR/$UNIT_NAME\"; rm -rf \"$DEST\""
