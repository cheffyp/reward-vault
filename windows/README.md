# Reward Guard — Windows PC enforcement (CHEFFYPC)

Blocks gaming on the Windows PC whenever the Reward Vault has **no active timer**. Any
running reward timer (Handheld / Grinder / Raid — all three tiers) unlocks everything.
Before a timer ends you get warning pop-ups (default **10 min** and **5 min** left) that
let you spend a vaulted reward to add time, or open the dashboard to buy more.

### Why kill processes instead of Pi-hole DNS blocking?

This PC has Mullvad VPN and WireGuard installed — a VPN tunnels DNS straight past Pi-hole,
so DNS-level blocking wouldn't hold here. Reward Guard instead **terminates game processes**,
which a VPN can't bypass. It blocks by *install location* (your Steam libraries and game
folders) plus the launcher names, so it covers every current and future game without you
maintaining a list of `.exe`s.

## Install

1. Copy this `windows\` folder to the PC (e.g. via the Tailscale share, a USB stick, or
   `scp` from the Pi).
2. Right-click `install-reward-guard.ps1` → **Run with PowerShell** (it will prompt for
   Administrator — needed to register the task and stop elevated games). If double-click is
   blocked, open an elevated PowerShell and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-reward-guard.ps1
   ```

That copies the agent to `C:\ProgramData\RewardGuard\` and registers a scheduled task
**RewardGuard** that:
- starts at logon and runs in your session (so warnings can appear),
- runs with highest privileges (can stop elevated games),
- re-launches every 2 minutes if it was closed (auto-restart), single-instance,
- runs hidden, no time limit.

## Verify it works

```powershell
# watch the log live
Get-Content C:\ProgramData\RewardGuard\reward-guard.log -Tail 30 -Wait
```
- With **no active timer**: launch any Steam game — it should die within ~5 seconds and the
  log shows `killed: <game>`. The log shows `state: LOCKED (blocking games)`.
- On the dashboard, **Use** a reward to start a timer → log shows `state: unlocked`, and
  games launch normally.
- Let the timer wind down (or set the Raid duration low to test): at 10 and 5 minutes left
  you get the warning dialog with **+time** buttons.

Tip for a quick end-to-end test without waiting: on the dashboard set the Raid duration to a
few minutes and lower `warnMinutes` in the config to e.g. `[2, 1]`, then start a Raid timer.

## Configure

Edit `C:\ProgramData\RewardGuard\reward-guard.config.json` (the installed copy), then restart
the task: `Restart-ScheduledTask RewardGuard`.

| Key | Meaning |
|---|---|
| `apiUrls` | Reward Vault URLs to try in order. Defaults: Tailscale HTTPS first, then LAN HTTP. |
| `pollSeconds` | How often to check state / re-kill (default 5). |
| `warnMinutes` | Minutes-left thresholds that trigger a warning pop-up (default `[10, 5]`). |
| `warnTimeoutSeconds` | Auto-close an ignored warning after this long (default 120). |
| `blockWhenUnreachable` | If the vault can't be reached: `false` = fail open (games allowed), `true` = fail closed (games blocked). Default `false`. See note below. |
| `skipCertCheck` | Set `true` only if you point `apiUrls` at an HTTPS host with an untrusted cert. The Tailscale name has a valid cert, so leave `false`. |
| `blockPaths` | Folder prefixes; any process whose `.exe` lives under one is killed while locked. Add other drives/launchers here. |
| `blockProcessNames` | Launcher process names (no `.exe`) to kill even if outside `blockPaths`. |
| `allowProcessNames` | Process names (no `.exe`) to never kill, even under a block path. |
| `allowPaths` | Folders to spare even though they're under a `blockPath`. Use for non-game utilities installed inside a Steam library — e.g. Wallpaper Engine, DisplayFusion. These win over `blockPaths`. |

**Note — utilities inside Steam:** some non-game apps install under `…\Steam\steamapps\common`
(Wallpaper Engine, DisplayFusion, Borderless Gaming, Driver Booster). The default `allowPaths`
already spares those. If you have another such utility getting killed, add its folder to
`allowPaths` (or its process name to `allowProcessNames`) and restart the task.

**`blockWhenUnreachable` trade-off:** `false` means if the Pi is off/unreachable, the PC is
*not* blocked — friendlier (a network blip won't kill a game) but bypassable by cutting the
Pi off. `true` is stricter but a Pi reboot will end gaming until it's back. The default is
`false`.

## Uninstall

```powershell
Unregister-ScheduledTask RewardGuard -Confirm:$false
Remove-Item C:\ProgramData\RewardGuard -Recurse -Force
```

## Dashboard

Once the agent is running, this PC shows up in the Reward Vault dashboard's **Device access**
panel (labelled `PC · games`) as **blocked** / **unblocked**, alongside the Pi-hole devices.
If the agent stops reporting for 30 seconds it shows as **offline** there. This is purely a
status report — the agent enforces locally regardless of what the dashboard shows.

## Notes & limits

- **Standard hardening.** The task runs in your user session so it can show warnings. A
  knowledgeable user with admin rights could disable the task or edit the config. For a child
  account this is usually plenty; true tamper-proofing (a SYSTEM service that can't be stopped)
  is a larger project — ask if you want it.
- **Clocks.** Warnings use the timer's end time vs the PC clock; keep Windows time sync on
  (it is by default) so "minutes left" is accurate.
- **Safety.** The agent never touches Windows/system processes, never kills anything under
  `C:\Windows\`, and protects shells (powershell/pwsh) and core OS processes by name.
