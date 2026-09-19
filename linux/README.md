# Reward Guard - Linux (Bazzite/KDE) enforcement

Blocks gaming on this machine (**CheffyLinux**) whenever the Reward Vault has **no active
timer**, by killing game processes. It never touches the network. Steam itself stays open,
and you can whitelist "productivity games" (e.g. Chill with You Lo-Fi Story) so they always
run. Any active reward timer (all three tiers) unlocks everything. Before a timer ends you
get a warning (default 10 and 5 min left) offering to add time or open the dashboard.

This mirrors the Mac/Windows agents: it blocks by **install location** (your Steam games
folder, `~/Games` for Lutris, `~/Faugus` for Battle.net and anything else launched through
Faugus) plus specific process names for games that hide their real path (FFXIV via
XIVLauncher/Wine), rather than maintaining a list of every game.

## Install

Run as the user you want enforced - **not** with `sudo`:

```bash
cd linux
bash install-reward-guard.sh
```

That copies the agent to `~/.local/share/RewardGuard/` and installs a per-user systemd unit
(`~/.config/systemd/user/reward-guard.service`) that:
- starts with your graphical session (`graphical-session.target`) so dialogs can show,
- restarts automatically if it stops (`Restart=on-failure`),
- needs no admin/root and no rpm-ostree layering - it only stops processes owned by the
  same user, and everything lives under `$HOME`.

Requires `jq` and `curl`, plus `kdialog` or `zenity` for the interactive warning and
`notify-send` for the toast - all already present on this box.

## Verify

```bash
tail -f ~/.local/share/RewardGuard/reward-guard.log
# or:
journalctl --user -u reward-guard -f
```
- With **no active timer**: launch a Steam game - it should die within ~5s and the log shows
  `killed: <name>` and `state: LOCKED (blocking games)`. Steam itself keeps running.
- Start a reward on the dashboard -> log shows `state: unlocked`, games launch normally.

## Configure

Edit `~/.local/share/RewardGuard/reward-guard.config.json`, then reload:
```bash
systemctl --user restart reward-guard
```

| Key | Meaning |
|---|---|
| `deviceName` | Label this device reports to the dashboard (`CheffyLinux`). |
| `apiUrls` | Reward Vault URLs to try in order (Tailscale HTTPS, then LAN). |
| `pollSeconds` | How often to check / re-kill (default 5). |
| `warnMinutes` | Minutes-left thresholds for the warning (default `[10, 5]`). |
| `warnTimeoutSeconds` | Auto-dismiss an ignored warning after this long. |
| `blockWhenUnreachable` | If the vault is unreachable: `false` = allow games (default), `true` = block. |
| `blockPaths` | Folders whose processes get killed while locked. Default: your Steam games folder, `~/Games` (Lutris), and `~/Faugus` (Faugus's Wine prefixes - Battle.net and its games). `~` expands to home. Also matched against a Wine game's `WINEPREFIX`, not just its exe path - see below. |
| `blockProcessNames` | Process names (no path, matched against `/proc/<pid>/comm`, 15-char limit) to kill wherever they run - covers FFXIV/XIVLauncher, plus the Battle.net launcher itself as a backstop. |
| `allowPaths` | Folders to spare even under a `blockPath` - Wallpaper Engine, your productivity games. These win over `blockPaths`. |
| `allowProcessNames` | Process names to never kill (Steam and gamescope are listed here). |

**Steam stays open, games don't.** `blockPaths` only covers `steamapps/common`; the Steam
client binary itself is spared, and `steam`/`steam.sh`/`steamwebhelper` are explicitly
allow-listed by name too.

**FFXIV.** You have XIVLauncher installed as a Flatpak (`dev.goats.xivlauncher`). Because it
runs the game through a bundled Wine/Proton, the real executable path is hidden inside its
prefix - so it's blocked by **process name** instead (`ffxiv_dx11.exe`, `xivlauncher`, etc.,
matched against the truncated 15-character Linux process name). If it doesn't get killed,
check the actual name while it's running:
```bash
ps -eo pid,comm | grep -i xiv
```
and add whatever shows up to `blockProcessNames`.

**Lutris.** Installed on this box; its default install folder `~/Games` is blocked. If you
install Lutris games elsewhere, add those folders to `blockPaths` too.

**Battle.net / Faugus.** Battle.net isn't a Steam game and doesn't go through Steam at all -
it runs through [Faugus Launcher](https://github.com/Faugus/faugus-launcher), a Wine/Proton
frontend. Like FFXIV, a Wine-run `.exe` never shows up at a real path via `/proc/<pid>/exe`
(that just resolves to the wine binary), so plain path-blocking wouldn't catch it. Instead,
`reward-guard.sh` also reads each process's `WINEPREFIX` (from `/proc/<pid>/environ`) and
checks that against `blockPaths` too. Faugus's default Wine-prefix root is `~/Faugus`
(confirmed from its source - `PREFIXES_DIR = PathManager.user_home('Faugus')`), and every
game gets its own subfolder there (`~/Faugus/<game>/`). Battle.net installs *all* of its own
games (Overwatch, Diablo, WoW, etc.) inside its own single prefix, and Faugus sets
`WINEPREFIX` for the whole process tree it launches - so blocking `~/Faugus` once catches
Battle.net **and** everything it launches, plus any other non-Steam game you add in Faugus,
without needing a list of every game. `battle.net.exe`/`agent.exe` are also in
`blockProcessNames` as a name-based backstop for the launcher itself.

If you changed Faugus's "Default Prefixes Location" in its Settings away from `~/Faugus`, or
gave the Battle.net entry a custom prefix path, update/add that path in `blockPaths` to
match. If a Battle.net game still doesn't die when locked, check what's actually running:
```bash
ps -eo pid,comm | grep -i battle
# or, to see the WINEPREFIX a running game process is using:
tr '\0' '\n' < /proc/<pid>/environ | grep WINEPREFIX
```

## Dashboard

This machine heartbeats its lock state, so it appears in the dashboard's **Device access**
panel labelled `PC · games`, alongside the Pi-hole devices and the Mac/Windows PC. Shows as
**offline** if it stops reporting for 30s.

## Uninstall

```bash
systemctl --user disable --now reward-guard
rm -f ~/.config/systemd/user/reward-guard.service
rm -rf ~/.local/share/RewardGuard
```

## Notes & limits

- **Standard hardening.** Runs in your user session so it can warn. A user with their own
  login could stop the service or edit the config - fine for self-enforcement, not
  tamper-proof against someone with full account access on this machine.
- **No network effect.** This only kills processes; DNS/internet is untouched.
- **Immutable-image friendly.** Nothing here needs `rpm-ostree install` or a reboot - it's
  just files under `$HOME` plus a systemd `--user` unit.
