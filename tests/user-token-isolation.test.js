import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-user-token-test-'));
const legacyToken = 'ms_live_legacy0000000000000000000000';

await fs.writeFile(
  path.join(dataDir, 'admin-store.json'),
  JSON.stringify({
    users: [
      {
        id: 'usr_legacy',
        name: 'Legacy User',
        email: 'legacy@example.com',
        role: 'admin',
        status: 'active',
        apiToken: legacyToken,
        quotaLimit: 500,
        quotaUsed: 0,
      },
    ],
  }),
  'utf8'
);

process.env.MOTION_DATA_DIR = dataDir;
process.env.VPS_TOKEN = 'user-token-test-vps-secret-value';
process.env.ADMIN_TOKEN = 'user-token-test-admin-secret-value';
process.env.HMAC_SECRET = 'user-token-test-hmac-secret-value';

const {
  createUser,
  findUserByToken,
  initConfigStore,
  projectPublicUser,
  regenerateUserToken,
} = await import('../vps-server/config-store.js');

test('legacy plaintext user tokens are hashed and removed from the store', async () => {
  await initConfigStore();

  const raw = await fs.readFile(path.join(dataDir, 'admin-store.json'), 'utf8');
  assert.equal(raw.includes(legacyToken), false, 'plaintext token must not reach admin-store.json');

  const stored = JSON.parse(raw);
  const legacy = stored.users.find((user) => user.id === 'usr_legacy');
  assert.equal(legacy.apiToken, undefined);
  assert.equal(typeof legacy.apiTokenHash, 'string');
  assert.equal(legacy.apiTokenHash.length, 64);
});

test('a legacy token still authenticates after the hashed restart', async () => {
  await initConfigStore();
  const found = await findUserByToken(legacyToken);
  assert.equal(found?.id, 'usr_legacy');

  const restarted = await import(`../vps-server/config-store.js?token=${Date.now()}`);
  await restarted.initConfigStore();
  const restored = await restarted.findUserByToken(legacyToken);
  assert.equal(restored?.id, 'usr_legacy');
  assert.equal(await restarted.findUserByToken('ms_live_wrong_token_value'), null);
});

test('created users never persist their plaintext token', async () => {
  const created = await createUser({ name: 'Fresh', email: 'fresh@example.com' });
  const raw = await fs.readFile(path.join(dataDir, 'admin-store.json'), 'utf8');
  assert.equal(raw.includes(created.apiToken), false);

  const found = await findUserByToken(created.apiToken);
  assert.equal(found?.id, created.id);
  assert.equal(found?.apiToken, undefined);
});

test('rotating a token invalidates the previous value', async () => {
  const created = await createUser({ name: 'Rotate', email: 'rotate@example.com' });
  const original = created.apiToken;

  const rotated = await regenerateUserToken(created.id);
  assert.notEqual(rotated.apiToken, original);
  assert.equal(await findUserByToken(original), null);
  assert.equal((await findUserByToken(rotated.apiToken))?.id, created.id);

  const raw = await fs.readFile(path.join(dataDir, 'admin-store.json'), 'utf8');
  assert.equal(raw.includes(rotated.apiToken), false);
  assert.equal(raw.includes(original), false);
});

test('public projection keeps masking based on the stored hash', async () => {
  const created = await createUser({ name: 'Masked', email: 'masked@example.com' });
  const stored = (await initConfigStore()).users.find((user) => user.id === created.id);
  const projected = projectPublicUser(stored);
  assert.equal(projected.apiToken, undefined);
  assert.equal(JSON.stringify(projected).includes(created.apiToken), false);
  assert.equal(typeof projected.maskedApiToken, 'string');
});

test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});
