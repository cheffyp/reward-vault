# Reward Guard - macOS enforcement

Blocks gaming on the Mac whenever the Reward Vault has **no active timer**, by killing game
processes. It never touches the network. Steam itself stays open, and you can whitelist
"productivity games" (e.g. Chill with You Lo-Fi Story) so they always run. Any active reward
timer (all three tiers) unlocks everything. Before a timer ends you get a warning (default 10
and 5 min left) offering to add time or open the dashboard.

This mirrors the Windows agent: it blocks by **install location** (your Steam games folder),
not by maintaining a list of every game, and spares specific folders via `allowPaths`.

## Install

Run as the user you want enforced (a child account, say) - **not** with `sudo`:

```bash
cd mac
bash install-reward-guard.sh
```

That copies the agent to `~/Library/Application Support/RewardGuard/` and installs a per-user
LaunchAgent (`~/Library/LaunchAgents/com.rewardvault.guard.plist`) that:
- starts at login and runs in your session (so warnings can appear),
- restarts automatically if it stops (`KeepAlive`),
- needs no admin - it only stops processes owned by the same user.

The first time it shows a notification/dialog, macOS may ask to allow it to send
notifications / control "System Events" - approve that, or warnings won't show (blocking
still works either way).

## Verify

```bash
tail -f ~/Library/Application\ Support/RewardGuard/reward-guard.log
```
- With **no active timer**: launch a Steam game - it should die within ~5s and the log shows
  `killed: <game>` and `state: LOCKED (blocking games)`. Steam itself and Chill with You keep
  running.
- Start a reward on the dashboard -> log shows `state: unlocked`, games launch normally.

## Configure

Edit `~/Library/Application Support/RewardGuard/reward-guard.config.json`, then reload:
```bash
launchctl kickstart -k gui/$(id -u)/com.rewardvault.guard
```

| Key | Meaning |
|---|---|
| `apiUrls` | Reward Vault URLs to try in order (Tailscale HTTPS, then LAN). |
| `pollSeconds` | How often to check / re-kill (default 5). |
| `warnMinutes` | Minutes-left thresholds for the warning (default `[10, 5]`). |
| `warnTimeoutSeconds` | Auto-dismiss an ignored warning after this long. |
| `blockWhenUnreachable` | If the vault is unreachable: `false` = allow games (default), `true` = block. |
| `blockPaths` | Folders whose processes get killed while locked. Default: the Steam games folder only. `~` expands to home. |
| `blockProcessNames` | Process names (no path) to kill wherever they run. Empty by default. |
| `allowPaths` | Folders to spare even under a `blockPath` - your productivity games. These win over `blockPaths`. |
| `allowProcessNames` | Process names to never kill (Steam client helpers are listed here). |

**Steam stays open, games don't.** `blockPaths` is only `…/Steam/steamapps/common`; the Steam
app lives in `/Applications/Steam.app` (explicitly skipped), so the client keeps running while
its games are killed.

**Allow your productivity games.** Add each one's folder under `steamapps/common` to
`allowPaths`. The default lists `Chill with You Lo-Fi Story` and a `REPLACE-WITH-COOP-GAME`
placeholder - set that to the co-op game's exact folder name.

## Dashboard

The Mac heartbeats its lock state, so it appears in the dashboard's **Device access** panel
(by its computer name) as blocked/unblocked, alongside the Pi-hole devices and the PC.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.rewardvault.guard
rm -rf ~/Library/Application\ Support/RewardGuard ~/Library/LaunchAgents/com.rewardvault.guard.plist
```

## Notes & limits

- **Standard hardening.** Runs in the user session so it can warn. A user with admin rights
  could unload the LaunchAgent. For a child (standard, non-admin) account this is solid.
- **No network effect.** This only kills processes; DNS/internet is untouched.
- **Non-Steam games.** If you install games outside Steam, add their folders to `blockPaths`
  (avoid blocking all of `/Applications`, which holds normal apps).
