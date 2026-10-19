import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-server-security-test-'));
const outputDir = path.join(projectRoot, 'output');
const outputFile = path.join(outputDir, 'security-test.mp4');

process.env.MOTION_DATA_DIR = dataDir;
process.env.VPS_TOKEN = 'integration-vps-token-secure-value';
process.env.ADMIN_TOKEN = 'integration-admin-token-secure-value';
process.env.HMAC_SECRET = 'integration-hmac-secret-secure-value';
process.env.CORS_ORIGINS = 'https://dashboard.example.com';
process.env.REDIS_ENABLED = 'false';
process.env.MINIO_ENABLED = 'false';

const [{ app }, { getServiceKeys }] = await Promise.all([
  import('../vps-server/server.js'),
  import('../vps-server/config-store.js'),
]);

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(outputFile, Buffer.from('test-video'));

const server = await new Promise((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const serviceKeys = await getServiceKeys();

function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, options);
}

test('root redirects browsers to the public studio', async () => {
  const response = await request('/', { redirect: 'manual' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/studio');
});

test('liveness stays independent from Redis readiness', async () => {
  const response = await request('/live');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'alive' });
});

test('admin API rejects missing token and returns only masked secrets', async () => {
  const unauthorized = await request('/api/admin/keys');
  assert.equal(unauthorized.status, 401);

  const authorized = await request('/api/admin/keys', {
    headers: { 'X-Admin-Token': serviceKeys.adminToken },
  });
  assert.equal(authorized.status, 200);
  const body = await authorized.text();
  assert.equal(body.includes(serviceKeys.adminToken), false);
  assert.equal(body.includes(serviceKeys.vpsToken), false);
  assert.equal(body.includes(serviceKeys.hmacSecret), false);
});

test('CORS preflight allows configured origin and rejects other origins', async () => {
  const allowed = await request('/api/admin/keys', {
    method: 'OPTIONS',
    headers: { Origin: 'https://dashboard.example.com' },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://dashboard.example.com');

  const rejected = await request('/api/admin/keys', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

test('admin overview exposes provider-aware config without raw keys', async () => {
  const authorized = await request('/api/admin/overview', {
    headers: { 'X-Admin-Token': serviceKeys.adminToken },
  });
  assert.equal(authorized.status, 200);
  const payload = await authorized.json();
  assert.equal(payload.activeAiProvider, 'river');
  assert.equal(payload.aiProviders.river.baseUrl, 'https://api.river.ai');
  assert.equal(payload.aiProviders.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(payload.aiProviders.deepseek.model, 'deepseek-chat');
  assert.equal(JSON.stringify(payload).includes(serviceKeys.adminToken), false);
});

test('admin keys endpoint returns both provider configs with masked keys only', async () => {
  const authorized = await request('/api/admin/keys', {
    headers: { 'X-Admin-Token': serviceKeys.adminToken },
  });
  assert.equal(authorized.status, 200);
  const payload = await authorized.json();
  assert.equal(payload.activeAiProvider, 'river');
  assert.deepEqual(Object.keys(payload.aiProviders).sort(), ['deepseek', 'river']);
  assert.equal(payload.aiProviders.deepseek.model, 'deepseek-chat');
  assert.equal(payload.aiProviders.river.endpoint, undefined);
  assert.equal(payload.aiProviders.river.apiKey, undefined);
  assert.equal(typeof payload.aiProviders.river.maskedApiKey, 'string');
});

test('AI test endpoint requires admin token and rejects invalid input', async () => {
  const unauthorized = await request('/api/admin/ai/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Tell me a story.' }),
  });
  assert.equal(unauthorized.status, 401);

  const invalidPayloads = [
    { providerId: 'not-a-provider', prompt: 'Tell me a story.' },
    { prompt: 'Tell me a story.', temperature: '0.5' },
    { prompt: 'Tell me a story.', apiKey: 'must-not-override' },
  ];
  for (const payload of invalidPayloads) {
    const response = await request('/api/admin/ai/test', {
      method: 'POST',
      headers: {
        'X-Admin-Token': serviceKeys.adminToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }

  const contradictoryProvider = await request('/api/admin/river/test', {
    method: 'POST',
    headers: {
      'X-Admin-Token': serviceKeys.adminToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ providerId: 'deepseek', prompt: 'Tell me a story.' }),
  });
  assert.equal(contradictoryProvider.status, 400);
  const body = await contradictoryProvider.json();
  assert.match(body.error, /harus menggunakan provider river/);
});

test('output download requires auth and rejects unsafe filenames', async () => {
  const unauthorized = await request('/output/security-test.mp4');
  assert.equal(unauthorized.status, 401);

  const authorized = await request('/output/security-test.mp4', {
    headers: { 'X-Token': serviceKeys.vpsToken },
  });
  assert.equal(authorized.status, 200);
  assert.equal(await authorized.text(), 'test-video');

  const invalid = await request('/output/security-test.txt', {
    headers: { 'X-Token': serviceKeys.vpsToken },
  });
  assert.equal(invalid.status, 400);
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(outputFile, { force: true }),
  ]);
});
