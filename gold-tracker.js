/**
 * Gold Tracker — Habitica has no historical gold ledger (GET /api/v3/user only ever
 * returns a live snapshot of stats.gp), so this builds one going forward from two sources:
 *
 *   1. Purchases Reward Vault itself makes (exact — we set the price and score the task).
 *   2. Gold earned passively (party quests/drops), inferred by polling stats.gp on an
 *      interval and diffing against the last known value.
 *
 * Two SQLite tables carry that ledger:
 *   gold_log(id, ts, gp, delta, source)         source: 'poll' | 'purchase'
 *   purchase_log(id, ts, reward_name, task_id, cost, gp_after)
 *
 * On top of the ledger, a nightly job re-prices the rewards toward a target hours/day of
 * game time, and a same-day escalation multiplier discourages blowing through several
 * rewards in one sitting on a windfall day. Everything mutable-but-not-a-log (the current
 * computed base price, last reprice time, etc.) lives in the app's existing state.json via
 * the getState/saveState callbacks passed to init() — SQLite stays a pure append-only log.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const habitica = require('./habitica');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'vault.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS gold_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    gp REAL NOT NULL,
    delta REAL NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('poll','purchase'))
  );
  CREATE INDEX IF NOT EXISTS idx_gold_log_ts ON gold_log(ts);
  CREATE INDEX IF NOT EXISTS idx_gold_log_source ON gold_log(source);

  CREATE TABLE IF NOT EXISTS purchase_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    reward_name TEXT NOT NULL,
    task_id TEXT NOT NULL,
    cost REAL NOT NULL,
    gp_after REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_purchase_log_ts ON purchase_log(ts);
  CREATE INDEX IF NOT EXISTS idx_purchase_log_reward ON purchase_log(reward_name);
`);

// ============ CONFIG (env vars, same style as the rest of the app) ============
function numEnv(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

const CONFIG = {
  // Stay well under Habitica's rate limit (~30 req/min) — 15-30 min is the recommended range.
  pollIntervalMinutes: Math.max(5, numEnv('PRICING_POLL_INTERVAL_MINUTES', 20)),
  targetHoursPerDay: numEnv('PRICING_TARGET_HOURS_PER_DAY', 1.5),
  trailingWindowDays: Math.max(1, Math.round(numEnv('PRICING_TRAILING_WINDOW_DAYS', 7))),
  escalationFactor: numEnv('PRICING_ESCALATION_FACTOR', 1.15),
  priceClampPct: numEnv('PRICING_CLAMP_PCT', 20),
  // Local hour that matches your Habitica "Day Start" preference, for both the nightly
  // reprice and the same-day escalation reset. Default 0 = midnight.
  dayStartHour: Math.min(23, Math.max(0, Math.round(numEnv('PRICING_DAY_START_HOUR', 0)))),
  // Safe default: computes and logs everything but never calls PUT against Habitica.
  // Set PRICING_DRY_RUN=false once you've sanity-checked a few days of numbers.
  dryRun: process.env.PRICING_DRY_RUN !== 'false'
};

let getState = () => { throw new Error('gold-tracker not initialized'); };
let saveState = () => {};

function init(deps) {
  getState = deps.getState;
  saveState = deps.saveState;
}

// ============ TIME HELPERS ============
const DAY_MS = 24 * 60 * 60 * 1000;

// Start-of-"Habitica day" boundary (local time) containing `ts`.
function dayBoundaryMs(ts, dayStartHour) {
  const d = new Date(ts);
  d.setHours(dayStartHour, 0, 0, 0);
  if (d.getTime() > ts) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function nextDayBoundaryMs(ts, dayStartHour) {
  const d = new Date(ts);
  d.setHours(dayStartHour, 0, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// ============ LEDGER READS ============
function getLastKnownGp() {
  const row = db.prepare('SELECT gp FROM gold_log ORDER BY ts DESC, id DESC LIMIT 1').get();
  return row ? row.gp : null;
}

function daysOfHistory(now) {
  const row = db.prepare(`SELECT MIN(ts) as minTs FROM gold_log WHERE source = 'poll'`).get();
  if (!row || row.minTs == null) return 0;
  return (now - row.minTs) / DAY_MS;
}

// Trailing average daily gold earned, from poll-sourced positive deltas only (negative
// poll deltas mean gold left the account some other way — e.g. spent directly in the
// Habitica app — and are excluded rather than counted as "earned").
function computeTrailingAverage(now) {
  const windowStart = now - CONFIG.trailingWindowDays * DAY_MS;
  const rows = db.prepare(
    `SELECT ts, delta FROM gold_log WHERE source = 'poll' AND delta > 0 AND ts >= ?`
  ).all(windowStart);
  const byDay = new Map();
  for (const row of rows) {
    const boundary = dayBoundaryMs(row.ts, CONFIG.dayStartHour);
    byDay.set(boundary, (byDay.get(boundary) || 0) + row.delta);
  }
  let total = 0;
  for (const v of byDay.values()) total += v;
  // Divide by the configured window, not just days-with-data, so a quiet day counts as 0
  // earned rather than being dropped from the average.
  return { avg: total / CONFIG.trailingWindowDays, daysWithData: byDay.size, total };
}

function countPurchasesToday(rewardName, now = Date.now()) {
  const boundary = dayBoundaryMs(now, CONFIG.dayStartHour);
  const row = db.prepare(
    'SELECT COUNT(*) as n FROM purchase_log WHERE reward_name = ? AND ts >= ?'
  ).get(rewardName, boundary);
  return row.n;
}

// { base, purchasesToday, effective } — effective is base * escalationFactor^purchasesToday.
// fallbackBase is used when we haven't computed our own base price yet (still warming up);
// pass the reward's live Habitica task.value there, or null if unavailable.
function computeEffectivePrice(rewardId, rewardName, fallbackBase) {
  const pricing = getState().pricing;
  const stored = pricing.rewardCost[rewardId];
  const base = stored != null ? stored : fallbackBase;
  const purchasesToday = countPurchasesToday(rewardName);
  const effective = base != null ? Math.max(1, Math.round(base * Math.pow(CONFIG.escalationFactor, purchasesToday))) : null;
  return { base, purchasesToday, effective };
}

// ============ PURCHASE INTEGRATION ============
// Called by the buy flow before scoring the task, to decide what to charge and whether to
// push that price to Habitica first.
function prepareForPurchase(rewardId, rewardName, task) {
  const { base, purchasesToday, effective } = computeEffectivePrice(rewardId, rewardName, task.value);
  const dryRun = CONFIG.dryRun;
  return {
    taskId: task.id,
    base,
    purchasesToday,
    effectiveCost: effective,
    currentHabiticaValue: task.value,
    dryRun,
    shouldSetValue: !dryRun && effective != null && effective !== task.value
  };
}

// Called right after a successful score/up. Writes both log rows in one transaction and
// (implicitly, since getLastKnownGp reads the ledger) makes the next poll's delta reflect
// only newly earned gold from this point on.
const insertGoldRow = db.prepare('INSERT INTO gold_log (ts, gp, delta, source) VALUES (?, ?, ?, ?)');
const insertPurchaseRow = db.prepare(
  'INSERT INTO purchase_log (ts, reward_name, task_id, cost, gp_after) VALUES (?, ?, ?, ?, ?)'
);
const recordPurchaseTx = db.transaction((ts, rewardName, taskId, cost, gpAfter) => {
  insertGoldRow.run(ts, gpAfter, -cost, 'purchase');
  insertPurchaseRow.run(ts, rewardName, taskId, cost, gpAfter);
});

function recordPurchase({ rewardName, taskId, cost, gpAfter }) {
  recordPurchaseTx(Date.now(), rewardName, taskId, cost, gpAfter);
}

// ============ POLLER ============
async function pollGold() {
  try {
    const gp = await habitica.getGoldBalance();
    const lastKnown = getLastKnownGp();
    const delta = lastKnown == null ? 0 : gp - lastKnown;
    db.prepare('INSERT INTO gold_log (ts, gp, delta, source) VALUES (?, ?, ?, ?)').run(Date.now(), gp, delta, 'poll');
    console.log(`[gold-tracker] poll: gp=${gp}${lastKnown == null ? ' (baseline)' : `, delta=${delta >= 0 ? '+' : ''}${delta}`}`);
  } catch (e) {
    console.error('[gold-tracker] poll failed:', e.message);
  }
}

// ============ NIGHTLY RE-PRICING ============
// getRewardMeta() -> [{ id, name, hours }]
async function runNightlyReprice(getRewardMeta) {
  const state = getState();
  const now = Date.now();
  const history = daysOfHistory(now);
  const { avg } = computeTrailingAverage(now);
  state.pricing.trailingAvgDailyGold = avg;
  state.pricing.lastRepricedAt = now;

  if (history < CONFIG.trailingWindowDays) {
    state.pricing.status = 'warming-up';
    saveState();
    console.log(`[pricing] warming up (${history.toFixed(1)}/${CONFIG.trailingWindowDays} days of history) — trailing avg so far ${avg.toFixed(1)}gp/day, not adjusting prices yet`);
    return;
  }

  const rawBasePerHour = avg / CONFIG.targetHoursPerDay;
  const prevBase = state.pricing.basePricePerHour;
  let newBasePerHour = rawBasePerHour;
  if (prevBase != null && prevBase > 0) {
    const lo = prevBase * (1 - CONFIG.priceClampPct / 100);
    const hi = prevBase * (1 + CONFIG.priceClampPct / 100);
    newBasePerHour = Math.min(Math.max(rawBasePerHour, lo), hi);
  }
  state.pricing.basePricePerHour = newBasePerHour;
  state.pricing.status = 'active';

  for (const meta of getRewardMeta()) {
    const price = Math.max(1, Math.round(newBasePerHour * meta.hours));
    state.pricing.rewardCost[meta.id] = price;
    if (CONFIG.dryRun) {
      console.log(`[pricing] (dry-run) ${meta.name}: would set price to ${price}g (${meta.hours}h @ ${newBasePerHour.toFixed(2)}g/h)`);
      continue;
    }
    try {
      const task = await habitica.getRewardTask(meta.name);
      await habitica.setTaskValue(task.id, price);
      console.log(`[pricing] ${meta.name}: set Habitica price to ${price}g (${meta.hours}h @ ${newBasePerHour.toFixed(2)}g/h)`);
    } catch (e) {
      console.error(`[pricing] failed to update Habitica price for ${meta.name}:`, e.message);
    }
  }
  saveState();
}

function scheduleNightly(getRewardMeta) {
  const run = () => runNightlyReprice(getRewardMeta).catch(e => console.error('[pricing] nightly reprice failed:', e.message));
  const delay = nextDayBoundaryMs(Date.now(), CONFIG.dayStartHour) - Date.now();
  console.log(`[pricing] nightly reprice scheduled in ~${Math.round(delay / 60000)} min (day-start hour ${CONFIG.dayStartHour}:00)`);
  setTimeout(() => { run(); setInterval(run, DAY_MS); }, delay);
}

function start(getRewardMeta) {
  console.log(`[pricing] config: target=${CONFIG.targetHoursPerDay}h/day trailingWindow=${CONFIG.trailingWindowDays}d escalation=${CONFIG.escalationFactor}x clamp=±${CONFIG.priceClampPct}% pollEvery=${CONFIG.pollIntervalMinutes}min dryRun=${CONFIG.dryRun}`);
  pollGold();
  setInterval(pollGold, CONFIG.pollIntervalMinutes * 60 * 1000);
  scheduleNightly(getRewardMeta);
}

// ============ INSPECTION ============
function getGoldHistory(limit = 200) {
  return db.prepare('SELECT id, ts, gp, delta, source FROM gold_log ORDER BY ts DESC, id DESC LIMIT ?').all(limit);
}

function getPurchaseHistory(limit = 200) {
  return db.prepare('SELECT id, ts, reward_name, task_id, cost, gp_after FROM purchase_log ORDER BY ts DESC, id DESC LIMIT ?').all(limit);
}

// Cheap, no-network version for the 3s dashboard poll — falls back to null (caller keeps
// its own static default) rather than hitting Habitica on every request.
function getEffectivePriceForDisplay(rewardId, rewardName) {
  return computeEffectivePrice(rewardId, rewardName, null).effective;
}

// Fuller status for manual inspection — makes a live Habitica call per reward to show
// what's actually configured there right now, which is exactly the dry-run sanity check.
async function getPricingStatus(getRewardMeta) {
  const state = getState();
  const now = Date.now();
  const rewards = [];
  for (const meta of getRewardMeta()) {
    const { base, purchasesToday, effective } = computeEffectivePrice(meta.id, meta.name, null);
    let liveHabiticaValue = null;
    try {
      const task = await habitica.getRewardTask(meta.name);
      liveHabiticaValue = task.value;
    } catch (e) { /* best-effort, e.g. Habitica unreachable */ }
    rewards.push({
      id: meta.id, name: meta.name, hours: meta.hours,
      basePrice: base, purchasesToday, effectivePrice: effective, liveHabiticaValue
    });
  }
  return {
    config: { ...CONFIG },
    status: state.pricing.status,
    daysOfHistory: Math.round(daysOfHistory(now) * 10) / 10,
    trailingAvgDailyGold: state.pricing.trailingAvgDailyGold,
    basePricePerHour: state.pricing.basePricePerHour,
    lastRepricedAt: state.pricing.lastRepricedAt,
    lastKnownGp: getLastKnownGp(),
    rewards
  };
}

module.exports = {
  CONFIG,
  init,
  start,
  prepareForPurchase,
  recordPurchase,
  getEffectivePriceForDisplay,
  getPricingStatus,
  getGoldHistory,
  getPurchaseHistory
};
