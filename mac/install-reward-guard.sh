#!/bin/bash
# install-reward-guard.sh - set up the Reward Vault guard on macOS.
#
# Run as the user you want enforced (not with sudo):
#     bash install-reward-guard.sh
#
# Copies the agent to ~/Library/Application Support/RewardGuard and installs a per-user
# LaunchAgent that runs it at login and restarts it if it stops (KeepAlive). Re-run after
# editing the config to reload. Killing games needs no admin (same-user processes).

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/RewardGuard"
LA="$HOME/Library/LaunchAgents"
LABEL="com.rewardvault.guard"
PLIST="$LA/$LABEL.plist"
LOG="$DEST/reward-guard.log"
UID_NUM="$(id -u)"

mkdir -p "$DEST" "$LA"

# Stop an existing instance so the new agent/config takes effect.
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true

cp "$SRC/reward-guard.sh" "$DEST/reward-guard.sh"
chmod +x "$DEST/reward-guard.sh"

if [ -f "$DEST/reward-guard.config.json" ]; then
  echo "Config already present at $DEST/reward-guard.config.json - leaving it (edit there, or delete to reset)."
else
  cp "$SRC/reward-guard.config.json" "$DEST/reward-guard.config.json"
fi

# Generate the LaunchAgent with absolute paths.
sed -e "s#__SCRIPT__#$DEST/reward-guard.sh#g" \
    -e "s#__CONFIG__#$DEST/reward-guard.config.json#g" \
    -e "s#__LOG__#$LOG#g" \
    "$SRC/com.rewardvault.guard.plist" > "$PLIST"

launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

echo ""
echo "Installed and started $LABEL"
echo "  Agent:  $DEST/reward-guard.sh"
echo "  Config: $DEST/reward-guard.config.json"
echo "  Log:    $LOG"
echo ""
echo "Watch log:  tail -f \"$LOG\""
echo "Uninstall:  launchctl bootout gui/$UID_NUM/$LABEL ; rm -rf \"$DEST\" \"$PLIST\""
