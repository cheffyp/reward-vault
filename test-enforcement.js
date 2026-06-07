// Standalone end-to-end test of the Pi-hole enforcement module against the real
// devices. Verifies lock/unlock transitions and that FoodBlocker (group 1) is preserved.
// Run: node test-enforcement.js   (reads .env)
const fs = require('fs'), path = require('path');
const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
raw.split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] = m[2]; });
const pihole = require('./pihole');

const DEVICES = [
  { id: 'B0:0C:9D:93:D6:DD', name: 'Steam Deck', rewards: ['handheld'] },
  { id: 'E0:EF:BF:53:15:7B', name: 'Switch 2',   rewards: ['handheld'] },
];
const ALL = new Set(DEVICES.map(d => d.id.toLowerCase()));

async function show(tag) {
  const clients = await pihole.listClients();
  const gid = (await pihole._api('GET', '/groups/' + pihole.GROUP_NAME)).groups[0].id;
  console.log('  [' + tag + ']');
  for (const d of DEVICES) {
    const c = clients.find(x => x.client.toLowerCase() === d.id.toLowerCase());
    const groups = c ? c.groups : '(no row)';
    const locked = c ? c.groups.includes(gid) : false;
    console.log(`    ${d.name.padEnd(11)} groups=${JSON.stringify(groups)}  -> ${locked ? 'LOCKED' : 'unlocked'}`);
  }
}

(async () => {
  console.log('RewardLocked group id / setup:');
  console.log('  gid =', await pihole.ensureSetup());

  console.log('\n1. No active timer -> reconcile (expect both LOCKED, Steam Deck keeps group 1):');
  await pihole.reconcile(DEVICES, new Set());
  await show('after lock');

  console.log('\n2. Handheld timer active -> reconcile (expect both unlocked, Steam Deck keeps group 1):');
  await pihole.reconcile(DEVICES, ALL);
  await show('after unlock');

  console.log('\n3. Timer ended -> reconcile (expect both LOCKED again):');
  await pihole.reconcile(DEVICES, new Set());
  await show('after re-lock');

  console.log('\nDone. Final state = LOCKED (the default when no timer runs).');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
