# Reward Vault — Pi Backend

A small Node.js server that hosts the Habitica reward vault with multi-device sync.

## What you get
- **State synced across all your devices** (vault counts, history, active timer, settings)
- **Single source of truth** for the active timer — every device shows the same countdown
- **Multi-device alerts** — when a timer ends, every open device chimes/flashes/notifies
- **One-click dismiss** — dismissing the alert on any device stops it everywhere
- **Pi survives reboots** — systemd autostart, atomic state writes
- **Habitica integration** — gold balance and reward purchases proxied through the Pi (no JSONP, no CORS hacks)

## What you give up vs. GitHub Pages version
- **No HTTPS by default** → notifications and screen wake lock won't work over `http://192.168.x.x`. The chime, title flash, and vibration still work. (Fix: use Tailscale, or set up a self-signed cert.)
- **Pi must be running** — if it's down, vault is unreachable from any device.

---

## Setup

### 1. Install Node.js on the Pi

If you don't already have it (need version 18+):

```bash
# Check current version
node --version

# If missing or too old, install the latest LTS
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Drop the project on your Pi

```bash
# From your Pi, in your home directory or wherever you want it
mkdir -p ~/reward-vault
cd ~/reward-vault
# Copy server.js, package.json, and the public/ directory here
# (e.g., via scp, git clone, or a file manager)
```

Final directory structure:
```
~/reward-vault/
├── server.js
├── package.json
├── public/
│   └── index.html
└── data/                  ← auto-created on first run
    └── state.json         ← auto-created on first run
```

### 3. Install dependencies

```bash
cd ~/reward-vault
npm install
```

### 4. Test-run with your Habitica credentials

```bash
HABITICA_USER_ID=your-user-id-here HABITICA_API_KEY=your-api-key-here node server.js
```

You should see:
```
[state] no state file, starting fresh
[vault] listening on http://0.0.0.0:3000
[vault] state file: /home/pi/reward-vault/data/state.json
```

From any device on your network, open `http://YOUR_PI_IP:3000` — you should see the vault. Find your Pi's IP with `hostname -I` on the Pi itself.

If something looks wrong, check that:
- `HABITICA_USER_ID` and `HABITICA_API_KEY` are set (the gold pill shows "gold error" if they're not)
- Your Pi's firewall allows port 3000 (`sudo ufw allow 3000` if you use ufw)
- You're on the same network as the Pi

### 5. Set up autostart with systemd

```bash
# Edit the service file with your User ID, API Key, and any path adjustments
nano reward-vault.service

# Copy it to systemd
sudo cp reward-vault.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable reward-vault
sudo systemctl start reward-vault

# Check status
sudo systemctl status reward-vault

# View logs
sudo journalctl -u reward-vault -f
```

Now it'll start on boot and restart automatically if it crashes.

---

## How it works

**Frontend → Backend**
- The HTML polls `GET /api/state` every 3 seconds
- Actions (`buy`, `use`, `cancel`, `dismiss-alert`) are POSTs that mutate state and return immediately
- Gold is fetched separately via `GET /api/gold` (also reachable via the gold pill)

**Backend → Habitica**
- Pi reads gold and buys rewards directly using your User ID + API Key
- Apps Script is no longer in the data path for the vault (it's still useful for your fitness/calendar sync)

**Multi-device alert flow**
1. Timer expires server-side → server stores `pendingAlert` with the timer's unique ID
2. Each device polls and sees `pendingAlert`. If it hasn't already alerted for this timer ID, it starts chiming/flashing/notifying.
3. User clicks "Dismiss" on any device → that device POSTs `/api/dismiss-alert`
4. Server clears `pendingAlert`. On next poll (≤3s), all devices see no pending alert and stop their alerts.

**State persistence**
- Single JSON file at `data/state.json`
- Atomic writes (write to `.tmp`, then rename) — can't be corrupted by a power cut mid-write
- Loaded on boot. If the timer expired while the server was down, it's marked as a pending alert immediately.

---

## Customizing

### Changing rewards
Edit the `REWARDS` array at the top of `server.js`. Names must match Habitica reward names exactly. Restart the service:
```bash
sudo systemctl restart reward-vault
```

### Changing the port
Set `PORT=8080` in the systemd unit's environment.

### Backing up state
```bash
cp ~/reward-vault/data/state.json ~/state-backup-$(date +%F).json
```

---

## Troubleshooting

**"offline" indicator on the page**
- Pi isn't reachable. Check `sudo systemctl status reward-vault`.

**"gold error" status**
- Pi can reach the network but Habitica calls are failing. Check the journalctl logs for the actual error. Most common: bad API key.

**Timer doesn't end on time**
- The server checks every second. If you saw a delay, the Pi might have been under heavy load. Check `top`.

**Phone alerts don't fire when locked**
- This is a browser limitation, not a server one. The browser pauses JavaScript when the tab isn't open. The system notification (if HTTPS) is the only thing that fires reliably while phone is locked. For real always-on alerts you'd want a native app or push notifications, both of which are larger projects.
