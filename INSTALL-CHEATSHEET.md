# Reward Vault - install cheatsheet

Quick setup for each device. The Reward Vault server runs on the Pi and is reachable at:
- Tailscale: `https://raspberrypi.tail08dd2f.ts.net:3443`
- LAN: `http://192.168.0.78:3000`

Both agents try the Tailscale URL first, then the LAN URL.

How enforcement works everywhere: while **no reward timer is active**, games are blocked;
**any** active timer (Handheld / Grinder / Raid) unlocks everything. The PC and Mac kill game
*processes* (never the network); the iPad uses Screen Time; Steam Deck / Switch 2 use Pi-hole.

---

## Windows (CHEFFYPC)

```powershell
# 1. get the files onto the PC (pull from the Pi over Tailscale, or copy the windows\ folder)
scp admin@raspberrypi.tail08dd2f.ts.net:/home/admin/reward-vault/windows/* .

# 2. (only if reinstalling with new defaults) refresh the installed config
Remove-Item C:\ProgramData\RewardGuard\reward-guard.config.json -ErrorAction SilentlyContinue

# 3. install (elevates itself; registers a logon scheduled task that auto-restarts)
powershell -ExecutionPolicy Bypass -File .\install-reward-guard.ps1

# verify
Get-Content C:\ProgramData\RewardGuard\reward-guard.log -Tail 20 -Wait
```
- Steam stays open; Steam games, FFXIV, and XIVLauncher are killed when locked.
- Edit config later: `C:\ProgramData\RewardGuard\reward-guard.config.json` then
  `Restart-ScheduledTask RewardGuard`
- Uninstall: `Unregister-ScheduledTask RewardGuard -Confirm:$false; Remove-Item C:\ProgramData\RewardGuard -Recurse -Force`

---

## Mac

Run as the user being enforced - **not** with sudo.

```bash
# 1. get the files
scp -r admin@raspberrypi.tail08dd2f.ts.net:/home/admin/reward-vault/mac ~/
cd ~/mac

# 2. install (per-user LaunchAgent; runs at login, auto-restarts via KeepAlive)
bash install-reward-guard.sh

# verify
tail -f ~/Library/Application\ Support/RewardGuard/reward-guard.log
```
- Steam + Chill with You + On-Together stay open; other Steam games are killed when locked.
- First dialog: approve the macOS notification/automation prompt so warnings can show.
- Edit config later: `~/Library/Application Support/RewardGuard/reward-guard.config.json` then
  `launchctl kickstart -k gui/$(id -u)/com.rewardvault.guard`
- Uninstall: `launchctl bootout gui/$(id -u)/com.rewardvault.guard; rm -rf ~/Library/Application\ Support/RewardGuard ~/Library/LaunchAgents/com.rewardvault.guard.plist`

---

## iPad (Apple Screen Time - manual)

No agent possible; set this up once from the **parent** device via Family Sharing.

1. Settings -> Screen Time -> set a **passcode the child doesn't know** (and manage the child
   via Family Sharing so they can't change it).
2. Screen Time -> **App Limits** -> Add Limit -> tick **Games** -> **1 minute** ->
   **Block at End of Limit** ON. (Web + non-game apps stay working.)
3. Allow your productivity apps: if they're a "Game" category app, limit individual game apps
   instead of the whole category, and add the productivity ones to **Always Allowed**.
4. Grant earned time: when a reward is used in the vault, open the game -> **Ask For More
   Time** -> approve on the parent device (or enter the Screen Time passcode).

Full detail: [`ipad/README.md`](ipad/README.md).

---

## Quick reference

| Device | Mechanism | Config location | Reload command |
|---|---|---|---|
| Windows | PowerShell scheduled task | `C:\ProgramData\RewardGuard\reward-guard.config.json` | `Restart-ScheduledTask RewardGuard` |
| Mac | bash LaunchAgent | `~/Library/Application Support/RewardGuard/reward-guard.config.json` | `launchctl kickstart -k gui/$(id -u)/com.rewardvault.guard` |
| iPad | Apple Screen Time | on-device (parent managed) | n/a (manual) |
| Steam Deck / Switch 2 | Pi-hole group | `enforcement.json` on the Pi | `curl -X POST http://localhost:3000/api/enforcement/reconcile` |

All four show up in the dashboard's **Device access** panel (PC/Mac heartbeat their lock state;
Pi-hole devices show their DNS lock state). The iPad won't appear there (Screen Time is manual).
