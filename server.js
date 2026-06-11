/**
 * Reward Vault — Pi backend
 *
 * Endpoints:
 *   GET  /api/state                 → full vault state (poll target)
 *   POST /api/buy                   → buy a reward in Habitica
 *   POST /api/use                   → use a reward (start timer, decrement vault)
 *   POST /api/extend                → add time to the active timer (consume another reward)
 *   POST /api/cancel                → cancel active timer (return reward to vault)
 *   POST /api/dismiss-alert         → dismiss the pending alert (any device)
 *   POST /api/raid-duration         → update raid ticket duration
 *   GET  /api/gold                  → just the gold balance from Habitica
 *
 * Static files in ./public/ are served at /
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// Load .env (simple KEY=VALUE lines) so secrets like PIHOLE_APP_PASSWORD are available
// without adding a dependency. systemd can alternatively pass these via Environment=.
// Must run before requiring ./pihole (it reads env at module load).
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    raw.split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) { /* no .env file — that's fine */ }
})();

const pihole = require('./pihole');

// ============ CONFIG ============
const PORT = process.env.PORT || 3000;
const HABITICA_USER_ID = process.env.HABITICA_USER_ID || '';
const HABITICA_API_KEY = process.env.HABITICA_API_KEY || '';
const X_CLIENT = HABITICA_USER_ID + '-RewardVaultPi';

// Hardcoded reward catalog (must match Habitica reward names exactly)
const REWARDS = [
  { id: 'handheld', name: 'The Handheld Pass',    cost: 15, defaultMins: 30, desc: '30 min handheld gaming', editable: false },
  { id: 'grinder',  name: "The Grinder's Fee",    cost: 25, defaultMins: 60, desc: '1 hr skill grinding',    editable: false },
  { id: 'raid',     name: 'High-End Raid Ticket', cost: 50, defaultMins: 60, desc: 'One raid lockout',       editable: true  }
];

// Cancelling within this window of starting refunds the reward to the vault (covers mis-clicks).
// After it, the reward is considered spent — cancel just ends the session, no refund.
const REFUND_GRACE_MS = 5 * 60 * 1000;

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// ============ STATE PERSISTENCE ============
// Single in-memory copy, atomic writes to disk
const initialState = {
  stacks: { handheld: 0, grinder: 0, raid: 0 },
  history: [],
  activeTimer: null,    // { id, rewardId, rewardName, startedAt, endsAt, totalMs, duration }
  pendingAlert: null,   // { timerId, rewardName, duration, completedAt }
  raidDuration: 60
};

let state;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  ensureDataDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      state = Object.assign({}, initialState, parsed);
      // Make sure stacks has all current reward ids
      REWARDS.forEach(r => { if (!(r.id in state.stacks)) state.stacks[r.id] = 0; });
      console.log('[state] loaded from disk');
    } catch (e) {
      console.error('[state] failed to parse state.json, starting fresh', e);
      state = JSON.parse(JSON.stringify(initialState));
    }
  } else {
    state = JSON.parse(JSON.stringify(initialState));
    console.log('[state] no state file, starting fresh');
  }
  // Boot-time check: did a timer expire while server was down?
  checkTimerExpiry();
}

function saveState() {
  ensureDataDir();
  // Atomic write: write to temp, then rename
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ============ PI-HOLE ENFORCEMENT ============
// enforcement.json maps each reward -> the devices it unlocks. Devices live in the
// Pi-hole "RewardLocked" group (all DNS blocked) by default; the device(s) for the
// currently-running reward are removed from the group while its timer is active.
const ENFORCEMENT_FILE = path.join(__dirname, 'enforcement.json');
let enforcementConfig = { rewards: {} };
let enforcementStatus = { enabled: pihole.ENABLED, reachable: false, groupName: pihole.GROUP_NAME, devices: [], lastReconcileAt: null, lastError: pihole.ENABLED ? null : 'PIHOLE_APP_PASSWORD not set' };

// Process-enforced clients (e.g. the Windows Reward Guard agent) report in here. They
// enforce locally and just heartbeat their lock state so the dashboard can show them.
const GUARD_STALE_MS = 30000;   // no heartbeat within this window -> shown as offline/stale
let guards = {};                // host -> { host, locked, version, lastSeen }

function guardList() {
  const now = Date.now();
  return Object.values(guards).map(g => ({ ...g, stale: (now - g.lastSeen) > GUARD_STALE_MS }));
}

function loadEnforcementConfig() {
  try {
    enforcementConfig = JSON.parse(fs.readFileSync(ENFORCEMENT_FILE, 'utf8'));
    if (!enforcementConfig.rewards) enforcementConfig.rewards = {};
    console.log('[enforce] config loaded');
  } catch (e) {
    enforcementConfig = { rewards: {} };
    console.warn('[enforce] no/invalid enforcement.json — enforcement disabled:', e.message);
  }
}

// Placeholder ids in the shipped template — skip these until the user fills in real MACs.
function isPlaceholder(id) { return /^PLACEHOLDER/i.test(id || ''); }

// Build the de-duplicated list of every enforced device, with the rewards each unlocks.
function getEnforcedDevices() {
  const byId = new Map();
  for (const [rewardId, r] of Object.entries(enforcementConfig.rewards || {})) {
    for (const d of (r.devices || [])) {
      if (!d || !d.id || isPlaceholder(d.id)) continue;
      const key = d.id.toLowerCase();
      if (!byId.has(key)) byId.set(key, { id: d.id, name: d.name || d.id, rewards: [] });
      byId.get(key).rewards.push(rewardId);
    }
  }
  return Array.from(byId.values());
}

// Which device ids should currently be UNLOCKED, derived from the single source of
// truth (state.activeTimer). No active timer -> nothing unlocked (all blocked).
function getUnlockedIds() {
  const set = new Set();
  if (state.activeTimer) {
    const r = enforcementConfig.rewards[state.activeTimer.rewardId];
    for (const d of ((r && r.devices) || [])) {
      if (d && d.id && !isPlaceholder(d.id)) set.add(d.id.toLowerCase());
    }
  }
  return set;
}

// Reconcile Pi-hole group membership to match current state. Best-effort: never throws
// into the timer/reward flow. Called on timer start, expiry, cancel, and at startup.
let reconcileChain = Promise.resolve();
function reconcileEnforcement(reason) {
  if (!pihole.ENABLED) return reconcileChain;
  const devices = getEnforcedDevices();
  const unlocked = getUnlockedIds();
  // Serialize reconciles so overlapping calls can't race on the Pi-hole API.
  reconcileChain = reconcileChain.then(async () => {
    try {
      const snap = await pihole.reconcile(devices, unlocked);
      enforcementStatus = { ...snap, lastReconcileAt: Date.now() };
      const open = snap.devices.filter(d => d.locked === false).map(d => d.name);
      console.log(`[enforce] reconciled (${reason || 'manual'}): ${open.length ? 'unlocked ' + open.join(', ') : 'all locked'}`);
    } catch (e) {
      enforcementStatus = { ...enforcementStatus, reachable: false, lastError: e.message, lastReconcileAt: Date.now() };
      console.error('[enforce] reconcile failed:', e.message);
    }
  });
  return reconcileChain;
}

// ============ TIMER EXPIRY CHECKER ============
// Runs every second. If activeTimer's endsAt is in the past, complete it.
function checkTimerExpiry() {
  if (!state.activeTimer) return;
  if (Date.now() >= state.activeTimer.endsAt) {
    const finished = state.activeTimer;
    state.activeTimer = null;
    state.pendingAlert = {
      timerId: finished.id,
      rewardId: finished.rewardId,
      rewardName: finished.rewardName,
      duration: finished.duration,
      completedAt: Date.now()
    };
    console.log('[timer] expired:', finished.rewardName);
    saveState();
    reconcileEnforcement('timer-expiry');  // re-lock the reward's devices
  }
}
setInterval(checkTimerExpiry, 1000);

// Periodic best-effort reconcile. Re-asserts desired Pi-hole state and, crucially,
// self-heals a transient failure (e.g. Pi-hole was restarting when we last tried) —
// otherwise a single "fetch failed" would stick until the next user action.
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || '60000', 10);
if (pihole.ENABLED && RECONCILE_INTERVAL_MS > 0) {
  setInterval(() => reconcileEnforcement('periodic'), RECONCILE_INTERVAL_MS);
}

// ============ HABITICA CLIENT ============
async function habiticaFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'x-api-user': HABITICA_USER_ID,
      'x-api-key': HABITICA_API_KEY,
      'x-client': X_CLIENT,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = (body && body.message) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function getGoldBalance() {
  const data = await habiticaFetch('https://habitica.com/api/v3/user?userFields=stats.gp');
  return Math.floor(data.data.stats.gp);
}

async function buyHabiticaReward(rewardName) {
  // Find reward by exact name
  const tasksData = await habiticaFetch('https://habitica.com/api/v3/tasks/user?type=rewards');
  const reward = tasksData.data.find(t => t.text === rewardName);
  if (!reward) throw new Error('reward not found in Habitica: ' + rewardName);

  // Check affordability (server-side guard — the buy will fail anyway if short, but better message)
  const userData = await habiticaFetch('https://habitica.com/api/v3/user?userFields=stats.gp');
  const currentGold = userData.data.stats.gp;
  if (currentGold < reward.value) {
    throw new Error(`insufficient gold (have ${Math.floor(currentGold)}, need ${reward.value})`);
  }

  // Score it up — deducts gold for custom rewards
  const scoreData = await habiticaFetch(
    `https://habitica.com/api/v3/tasks/${reward.id}/score/up`,
    { method: 'POST' }
  );

  return {
    cost: reward.value,
    gold: Math.floor(scoreData.data.gp || 0)
  };
}

// ============ EXPRESS APP ============
const app = express();
app.use(express.json());

// Permissive CORS for local network use
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ----- State endpoints -----
app.get('/api/state', (req, res) => {
  // Lightweight check before responding (catches expiry between 1s ticks)
  checkTimerExpiry();
  res.json({
    rewards: REWARDS,
    stacks: state.stacks,
    history: state.history.slice(0, 50),
    activeTimer: state.activeTimer,
    pendingAlert: state.pendingAlert,
    raidDuration: state.raidDuration,
    enforcement: enforcementStatus,
    guards: guardList(),
    serverTime: Date.now()
  });
});

// Cached enforcement status (updated on each reconcile — cheap, no live Pi-hole call).
app.get('/api/enforcement', (req, res) => {
  res.json({ ok: true, ...enforcementStatus, guards: guardList() });
});

// Heartbeat from a process-enforcement agent (Windows Reward Guard). Best-effort, in-memory.
app.post('/api/guard/heartbeat', (req, res) => {
  const { host, locked, version } = req.body || {};
  if (!host) return res.status(400).json({ ok: false, error: 'host required' });
  const key = String(host).slice(0, 64);
  guards[key] = {
    host: key,
    locked: !!locked,
    version: version ? String(version).slice(0, 32) : undefined,
    lastSeen: Date.now()
  };
  res.json({ ok: true });
});

app.get('/api/guards', (req, res) => {
  res.json({ ok: true, guards: guardList() });
});

// Force a live reconcile + fresh snapshot (e.g. after editing enforcement.json).
app.post('/api/enforcement/reconcile', async (req, res) => {
  loadEnforcementConfig();
  await reconcileEnforcement('manual-api');
  res.json({ ok: true, ...enforcementStatus });
});

app.get('/api/gold', async (req, res) => {
  try {
    const gold = await getGoldBalance();
    res.json({ ok: true, gold });
  } catch (e) {
    console.error('[gold] failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/buy', async (req, res) => {
  const { rewardId } = req.body || {};
  const reward = REWARDS.find(r => r.id === rewardId);
  if (!reward) return res.status(400).json({ ok: false, error: 'unknown reward' });

  try {
    const result = await buyHabiticaReward(reward.name);
    state.stacks[rewardId] = (state.stacks[rewardId] || 0) + 1;
    state.history.unshift({
      type: 'buy',
      rewardId: rewardId,
      rewardName: reward.name,
      cost: result.cost,
      timestamp: Date.now()
    });
    state.history = state.history.slice(0, 100);
    saveState();
    res.json({ ok: true, gold: result.gold, cost: result.cost });
  } catch (e) {
    console.error('[buy] failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/use', (req, res) => {
  const { rewardId } = req.body || {};
  const reward = REWARDS.find(r => r.id === rewardId);
  if (!reward) return res.status(400).json({ ok: false, error: 'unknown reward' });
  if (state.activeTimer) return res.status(409).json({ ok: false, error: 'a timer is already running' });
  if ((state.stacks[rewardId] || 0) === 0) return res.status(400).json({ ok: false, error: 'vault is empty for this reward' });

  const mins = reward.editable ? state.raidDuration : reward.defaultMins;
  const totalMs = mins * 60 * 1000;
  const now = Date.now();

  state.activeTimer = {
    id: 't_' + now + '_' + Math.floor(Math.random() * 1e6),
    rewardId,
    rewardName: reward.name,
    startedAt: now,
    endsAt: now + totalMs,
    totalMs,
    duration: mins
  };
  state.stacks[rewardId] -= 1;
  state.history.unshift({
    type: 'use',
    rewardId,
    rewardName: reward.name,
    duration: mins,
    timestamp: now
  });
  state.history = state.history.slice(0, 100);
  // Clear any old pending alert when starting a new timer
  state.pendingAlert = null;
  saveState();
  reconcileEnforcement('timer-start');  // unlock this reward's devices
  res.json({ ok: true, activeTimer: state.activeTimer });
});

app.post('/api/cancel', (req, res) => {
  if (!state.activeTimer) return res.status(409).json({ ok: false, error: 'no active timer' });
  const cancelled = state.activeTimer;
  // Only refund if cancelled within the grace window. After that the reward is spent, so we
  // also leave the original 'use' entry in history (it was a real session, not a mis-click).
  const refunded = (Date.now() - cancelled.startedAt) < REFUND_GRACE_MS;
  if (refunded) {
    state.stacks[cancelled.rewardId] = (state.stacks[cancelled.rewardId] || 0) + 1;
    // Remove the corresponding 'use' entry from history (most recent matching)
    const idx = state.history.findIndex(h => h.type === 'use' && h.rewardId === cancelled.rewardId && h.timestamp === cancelled.startedAt);
    if (idx >= 0) state.history.splice(idx, 1);
  }
  state.activeTimer = null;
  saveState();
  reconcileEnforcement('timer-cancel');  // re-lock the reward's devices
  res.json({ ok: true, refunded });
});

// Extend the currently-running timer by consuming another reward from the vault.
// Lets you add time mid-session (e.g. from the PC's expiry warning) without ending it.
app.post('/api/extend', (req, res) => {
  const { rewardId } = req.body || {};
  if (!state.activeTimer) return res.status(409).json({ ok: false, error: 'no active timer to extend' });
  const reward = REWARDS.find(r => r.id === rewardId);
  if (!reward) return res.status(400).json({ ok: false, error: 'unknown reward' });
  if ((state.stacks[rewardId] || 0) === 0) return res.status(400).json({ ok: false, error: 'vault is empty for this reward' });

  const mins = reward.editable ? state.raidDuration : reward.defaultMins;
  const addMs = mins * 60 * 1000;
  state.activeTimer.endsAt += addMs;     // stack onto the current end, not "now"
  state.activeTimer.totalMs += addMs;
  state.activeTimer.duration += mins;
  state.stacks[rewardId] -= 1;
  state.history.unshift({
    type: 'extend',
    rewardId,
    rewardName: reward.name,
    duration: mins,
    timestamp: Date.now()
  });
  state.history = state.history.slice(0, 100);
  saveState();
  // Devices stay unlocked (timer still active); reconcile in case the extending reward
  // maps to additional devices. The active reward id is unchanged.
  reconcileEnforcement('timer-extend');
  res.json({ ok: true, activeTimer: state.activeTimer });
});

app.post('/api/dismiss-alert', (req, res) => {
  state.pendingAlert = null;
  saveState();
  res.json({ ok: true });
});

app.post('/api/raid-duration', (req, res) => {
  const { minutes } = req.body || {};
  const n = parseInt(minutes, 10);
  if (!n || n < 1 || n > 600) return res.status(400).json({ ok: false, error: 'invalid duration' });
  state.raidDuration = n;
  saveState();
  res.json({ ok: true, raidDuration: n });
});

// ============ STARTUP ============
const http = require('http');
const https = require('https');

loadState();

// Load device map and reconcile Pi-hole to current state. This handles the
// reboot-mid-timer case (req. 4): loadState() already expired any stale timer, so the
// reconcile below blocks/unblocks devices to match whatever the active timer is now.
loadEnforcementConfig();
if (pihole.ENABLED) {
  reconcileEnforcement('startup');
} else {
  console.warn('[enforce] PIHOLE_APP_PASSWORD not set — network enforcement disabled');
}

const HTTP_PORT = parseInt(process.env.PORT || '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY  = process.env.TLS_KEY;

// Always start HTTP (still useful for local IP access)
http.createServer(app).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[vault] HTTP listening on http://0.0.0.0:${HTTP_PORT}`);
});

// Start HTTPS if cert paths are configured
if (TLS_CERT && TLS_KEY) {
  try {
    const credentials = {
      cert: fs.readFileSync(TLS_CERT),
      key:  fs.readFileSync(TLS_KEY)
    };
    https.createServer(credentials, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[vault] HTTPS listening on https://0.0.0.0:${HTTPS_PORT}`);
    });
  } catch (e) {
    console.error('[vault] HTTPS failed to start:', e.message);
  }
} else {
  console.log('[vault] HTTPS not configured (set TLS_CERT and TLS_KEY env vars)');
}

console.log(`[vault] state file: ${STATE_FILE}`);
if (!HABITICA_USER_ID || !HABITICA_API_KEY) {
  console.warn('[vault] WARNING: HABITICA_USER_ID or HABITICA_API_KEY not set — gold/buy will fail');
}
