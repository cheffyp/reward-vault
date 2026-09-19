/**
 * Habitica API client for Reward Vault.
 *
 * Thin wrapper around the v3 API endpoints the app needs: reading gold, listing/updating
 * reward tasks, and scoring a reward task up (the actual "buy"). Shared by server.js (the
 * buy flow) and gold-tracker.js (the gold poller + nightly re-pricer), so credentials and
 * header construction live in exactly one place.
 */

const HABITICA_USER_ID = process.env.HABITICA_USER_ID || '';
const HABITICA_API_KEY = process.env.HABITICA_API_KEY || '';
const X_CLIENT = HABITICA_USER_ID + '-RewardVaultPi';
const BASE = 'https://habitica.com/api/v3';

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
  const data = await habiticaFetch(BASE + '/user?userFields=stats.gp');
  return Math.floor(data.data.stats.gp);
}

// Find a reward task by its exact Habitica display name (text).
async function getRewardTask(rewardName) {
  const tasksData = await habiticaFetch(BASE + '/tasks/user?type=rewards');
  const task = tasksData.data.find(t => t.text === rewardName);
  if (!task) throw new Error('reward not found in Habitica: ' + rewardName);
  return task; // { id, text, value, ... }
}

// Score a reward task up — this is what actually deducts its `value` in gold.
async function scoreUp(taskId) {
  return habiticaFetch(BASE + '/tasks/' + taskId + '/score/up', { method: 'POST' });
}

// Update a task's gold cost (the `value` field custom rewards are priced by).
async function setTaskValue(taskId, value) {
  return habiticaFetch(BASE + '/tasks/' + taskId, {
    method: 'PUT',
    body: JSON.stringify({ value })
  });
}

module.exports = {
  HABITICA_USER_ID,
  HABITICA_API_KEY,
  habiticaFetch,
  getGoldBalance,
  getRewardTask,
  scoreUp,
  setTaskValue
};
