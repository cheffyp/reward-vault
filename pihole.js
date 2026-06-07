/**
 * Pi-hole enforcement client for Reward Vault.
 *
 * Talks to the local Pi-hole v6 REST API using a dedicated *application password*
 * (env PIHOLE_APP_PASSWORD). No sudo is required at runtime — see README for why.
 *
 * Model:
 *   - A Pi-hole group "RewardLocked" carries a `.*` deny-regex, so any client in it
 *     has ALL DNS resolution blocked.
 *   - Enforced devices live in that group by default (blocked). To unlock a device we
 *     remove it from the group; to lock it we add it back.
 *   - A client's group list is [DEFAULT] when unlocked and [DEFAULT, RewardLocked]
 *     when locked. Default(0) is kept so unlocked devices get normal filtering.
 *
 * Everything here is best-effort: Pi-hole being unreachable must never break the
 * timer/reward logic. Callers get a resolved promise; failures are logged and recorded
 * in lastError.
 */

const DEFAULT_GROUP_ID = 0;
const REGEX_BLOCK_ALL = '.*';

const API_URL = (process.env.PIHOLE_API_URL || 'http://localhost:8082').replace(/\/$/, '');
const APP_PASSWORD = process.env.PIHOLE_APP_PASSWORD || '';
const GROUP_NAME = process.env.PIHOLE_GROUP_NAME || 'RewardLocked';
const ENABLED = !!APP_PASSWORD;

// ---- session ----
let sid = null;
let sidExpiresAt = 0;
let groupId = null;         // cached RewardLocked group id
let lastError = null;
let reachable = false;

function logErr(where, e) {
  lastError = where + ': ' + (e && e.message ? e.message : String(e));
  console.error('[pihole] ' + lastError);
}

async function authenticate() {
  const res = await fetch(API_URL + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: APP_PASSWORD })
  });
  const body = await res.json().catch(() => ({}));
  const s = body && body.session;
  if (!res.ok || !s || !s.valid || !s.sid) {
    throw new Error('auth failed: ' + (s && s.message ? s.message : 'HTTP ' + res.status));
  }
  sid = s.sid;
  // Refresh a little before the real expiry to avoid races.
  sidExpiresAt = Date.now() + Math.max(0, (s.validity || 1800) - 60) * 1000;
}

async function ensureSession() {
  if (!sid || Date.now() >= sidExpiresAt) await authenticate();
}

/**
 * Call the Pi-hole API with auth. Retries once after re-auth on a 401.
 */
async function api(method, path, body, _retried) {
  await ensureSession();
  const res = await fetch(API_URL + '/api' + path, {
    method,
    headers: {
      'sid': sid,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && !_retried) {
    sid = null;
    return api(method, path, body, true);
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const msg = (parsed && parsed.error && parsed.error.message) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  reachable = true;
  return parsed;
}

// ---- group + regex setup (idempotent) ----

async function getGroupId() {
  if (groupId != null) return groupId;
  try {
    const r = await api('GET', '/groups/' + encodeURIComponent(GROUP_NAME));
    if (r.groups && r.groups.length) { groupId = r.groups[0].id; return groupId; }
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return null;
}

/**
 * Make sure the RewardLocked group exists and carries the `.*` deny regex.
 * Safe to call repeatedly.
 */
async function ensureSetup() {
  let id = await getGroupId();
  if (id == null) {
    await api('POST', '/groups', {
      name: GROUP_NAME,
      comment: 'Reward Vault: members have all DNS blocked until a reward timer unlocks them',
      enabled: true
    });
    groupId = null;
    id = await getGroupId();
  }
  if (id == null) throw new Error('could not create or find group ' + GROUP_NAME);

  // Ensure the block-all regex exists and is assigned to this group.
  const existing = await api('GET', '/domains/deny/regex');
  const match = (existing.domains || []).find(d => d.domain === REGEX_BLOCK_ALL);
  if (!match) {
    await api('POST', '/domains/deny/regex', {
      domain: REGEX_BLOCK_ALL,
      comment: 'Reward Vault: block everything for ' + GROUP_NAME + ' members',
      groups: [id],
      enabled: true
    });
  } else if (!(match.groups || []).includes(id) || match.enabled === false) {
    const groups = Array.from(new Set([...(match.groups || []), id]));
    await api('PUT', '/domains/deny/regex/' + encodeURIComponent(REGEX_BLOCK_ALL), {
      type: 'deny', kind: 'regex', comment: match.comment, groups, enabled: true
    });
  }
  return id;
}

// ---- client (device) membership ----

async function listClients() {
  const r = await api('GET', '/clients');
  return r.clients || [];
}

/**
 * Set a device's RewardLocked membership while PRESERVING its other groups
 * (e.g. a separate FoodBlocker group keeps applying). Creates the client row if
 * it doesn't exist yet.
 *   locked=true  -> current groups + RewardLocked   (all DNS blocked)
 *   locked=false -> current groups - RewardLocked   (normal filtering)
 */
async function setDeviceLocked(clientId, locked, gid, existingClients) {
  const clients = existingClients || await listClients();
  const current = clients.find(c => c.client.toLowerCase() === clientId.toLowerCase());
  let groups = current ? [...(current.groups || [])] : [DEFAULT_GROUP_ID];
  groups = groups.filter(g => g !== gid);          // drop RewardLocked first
  if (locked) groups.push(gid);                    // re-add it only when locking
  if (groups.length === 0) groups = [DEFAULT_GROUP_ID];
  groups = Array.from(new Set(groups));
  if (current) {
    await api('PUT', '/clients/' + encodeURIComponent(clientId), {
      comment: current.comment || 'Reward Vault enforced device', groups
    });
  } else {
    await api('POST', '/clients', {
      client: clientId, comment: 'Reward Vault enforced device', groups
    });
  }
  return groups;
}

/**
 * Reconcile Pi-hole to a desired state.
 *   enforcedDevices: [{ id, name, rewards: [rewardId,...] }]
 *   unlockedIds:     Set of device ids that should currently be UNLOCKED
 * Returns a status snapshot (also used by the dashboard).
 */
async function reconcile(enforcedDevices, unlockedIds) {
  if (!ENABLED) {
    return { enabled: false, reachable: false, groupName: GROUP_NAME, devices: [], lastError: 'PIHOLE_APP_PASSWORD not set' };
  }
  const gid = await ensureSetup();
  const clients = await listClients();
  const results = [];
  for (const dev of enforcedDevices) {
    const shouldUnlock = unlockedIds.has(dev.id.toLowerCase());
    try {
      await setDeviceLocked(dev.id, !shouldUnlock, gid, clients);
      results.push({ id: dev.id, name: dev.name, rewards: dev.rewards, locked: !shouldUnlock, ok: true });
    } catch (e) {
      logErr('reconcile device ' + dev.id, e);
      results.push({ id: dev.id, name: dev.name, rewards: dev.rewards, locked: null, ok: false, error: e.message });
    }
  }
  return {
    enabled: true,
    reachable,
    groupName: GROUP_NAME,
    groupId: gid,
    devices: results,
    lastError
  };
}

module.exports = {
  ENABLED,
  GROUP_NAME,
  API_URL,
  ensureSetup,
  reconcile,
  listClients,
  // exposed for diagnostics / tests
  _api: api,
  getStatus: () => ({ enabled: ENABLED, reachable, groupName: GROUP_NAME, groupId, lastError })
};
