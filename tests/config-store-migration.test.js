import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-config-migration-test-'));
const legacySecrets = {
  vpsToken: 'legacy-vps-token-secure-value',
  adminToken: 'legacy-admin-token-secure-value',
  hmacSecret: 'legacy-hmac-secret-secure-value',
  webhookSecret: 'legacy-webhook-secret-secure-value',
};

await fs.writeFile(
  path.join(dataDir, 'admin-store.json'),
  JSON.stringify({ serviceKeys: legacySecrets }),
  'utf8'
);
process.env.MOTION_DATA_DIR = dataDir;
process.env.VPS_TOKEN = '';
process.env.ADMIN_TOKEN = '';
process.env.HMAC_SECRET = '';
process.env.WEBHOOK_SECRET = '';

const { getServiceKeys } = await import('../vps-server/config-store.js');

test('legacy secrets migrate before generated fallback replaces them', async () => {
  const serviceKeys = await getServiceKeys();
  assert.deepEqual(
    {
      vpsToken: serviceKeys.vpsToken,
      adminToken: serviceKeys.adminToken,
      hmacSecret: serviceKeys.hmacSecret,
      webhookSecret: serviceKeys.webhookSecret,
    },
    legacySecrets
  );

  const generated = JSON.parse(
    await fs.readFile(path.join(dataDir, 'generated-secrets.json'), 'utf8')
  );
  assert.deepEqual(generated, legacySecrets);

  const adminStore = await fs.readFile(path.join(dataDir, 'admin-store.json'), 'utf8');
  for (const secret of Object.values(legacySecrets)) {
    assert.equal(adminStore.includes(secret), false);
  }
});

test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});
