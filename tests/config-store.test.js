import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-config-test-'));
process.env.MOTION_DATA_DIR = dataDir;
process.env.VPS_TOKEN = 'change_me_strong_secret_token_2026';
process.env.ADMIN_TOKEN = 'ms_admin_master_2026';
process.env.HMAC_SECRET = 'your_hmac_secret_here';
process.env.RIVER_API_KEY = '';

const {
  getServiceKeys,
  projectPublicKey,
  projectPublicRiverConfig,
  projectPublicServiceKeys,
  projectPublicUser,
} = await import('../vps-server/config-store.js');

test('runtime secrets replace placeholders and persist outside config store', async () => {
  const serviceKeys = await getServiceKeys();
  assert.notEqual(serviceKeys.vpsToken, 'change_me_strong_secret_token_2026');
  assert.notEqual(serviceKeys.adminToken, 'ms_admin_master_2026');
  assert.notEqual(serviceKeys.hmacSecret, 'your_hmac_secret_here');
  assert.ok(serviceKeys.vpsToken.length > 32);
  assert.ok(serviceKeys.adminToken.length > 32);
  assert.ok(serviceKeys.hmacSecret.length > 32);

  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'generated-secrets.json'), 'utf8'));
  assert.equal(persisted.vpsToken, serviceKeys.vpsToken);
  assert.equal(persisted.adminToken, serviceKeys.adminToken);
  assert.equal(persisted.hmacSecret, serviceKeys.hmacSecret);

  const adminStore = await fs.readFile(path.join(dataDir, 'admin-store.json'), 'utf8');
  assert.ok(!adminStore.includes(serviceKeys.vpsToken));
  assert.ok(!adminStore.includes(serviceKeys.adminToken));
  assert.ok(!adminStore.includes(serviceKeys.hmacSecret));
});

test('public projections never expose raw secrets', async () => {
  const river = projectPublicRiverConfig({ apiKey: 'river-secret-key', model: 'deepseek' });
  const service = projectPublicServiceKeys({
    higgsfieldApiKey: 'higgsfield-secret',
    vpsToken: 'vps-secret-token',
    adminToken: 'admin-secret-token',
    hmacSecret: 'hmac-secret',
  });
  const key = projectPublicKey({ id: 'key-1', apiKey: 'river-secret-key', label: 'Primary' });
  const user = projectPublicUser({ id: 'user-1', apiToken: 'user-secret-token', email: 'user@example.com' });

  for (const projection of [river, service, key, user]) {
    const serialized = JSON.stringify(projection);
    assert.ok(!serialized.includes('river-secret-key'));
    assert.ok(!serialized.includes('higgsfield-secret'));
    assert.ok(!serialized.includes('vps-secret-token'));
    assert.ok(!serialized.includes('admin-secret-token'));
    assert.ok(!serialized.includes('hmac-secret'));
    assert.ok(!serialized.includes('user-secret-token'));
  }
  assert.equal(river.maskedApiKey, 'river-••••••••••••••••-key');
  assert.equal(user.apiToken, undefined);
  assert.equal(user.maskedApiToken, 'user-s••••••••••••••••oken');
});

test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});
