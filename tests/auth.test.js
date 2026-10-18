import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-auth-test-'));
process.env.MOTION_DATA_DIR = dataDir;
process.env.REQUIRE_HMAC_SIGNATURE = 'true';
delete process.env.VPS_TOKEN;
delete process.env.ADMIN_TOKEN;
delete process.env.HMAC_SECRET;

const { getServiceKeys } = await import('../vps-server/config-store.js');
const { adminAuth, verifySignature, safeSecretEqual } = await import('../vps-server/middleware/auth.js');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function runMiddleware(middleware, req) {
  const res = createResponse();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('safeSecretEqual compares secrets without type coercion', () => {
  assert.equal(safeSecretEqual('same-value', 'same-value'), true);
  assert.equal(safeSecretEqual('same-value', 'other-value'), false);
  assert.equal(safeSecretEqual('short', 'much-longer-value'), false);
  assert.equal(safeSecretEqual('', ''), false);
  assert.equal(safeSecretEqual(null, 'null'), false);
});

test('adminAuth rejects requests without credentials', async () => {
  const result = await runMiddleware(adminAuth, { headers: {}, query: {} });
  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 401);
  assert.match(result.res.body.error, /required|missing|unauthorized/i);
});

test('adminAuth rejects invalid credentials and accepts generated admin token', async () => {
  const serviceKeys = await getServiceKeys();
  const invalid = await runMiddleware(adminAuth, {
    headers: { 'x-admin-token': 'invalid-token' },
    query: {},
  });
  assert.equal(invalid.nextCalled, false);
  assert.equal(invalid.res.statusCode, 401);

  const valid = await runMiddleware(adminAuth, {
    headers: { 'x-admin-token': serviceKeys.adminToken },
    query: {},
  });
  assert.equal(valid.nextCalled, true);
  assert.equal(valid.res.statusCode, 200);
});

test('verifySignature uses HMAC_SECRET instead of X-Token', async () => {
  const serviceKeys = await getServiceKeys();
  const body = { html: '<html></html>', duration: 1 };
  const raw = JSON.stringify(body);
  const correctSignature = crypto
    .createHmac('sha256', serviceKeys.hmacSecret)
    .update(raw)
    .digest('hex');
  const tokenSignature = crypto
    .createHmac('sha256', serviceKeys.vpsToken)
    .update(raw)
    .digest('hex');

  const valid = await runMiddleware(verifySignature, {
    headers: { 'x-token': serviceKeys.vpsToken, 'x-signature': correctSignature },
    body,
  });
  assert.equal(valid.nextCalled, true);

  const invalid = await runMiddleware(verifySignature, {
    headers: { 'x-token': serviceKeys.vpsToken, 'x-signature': tokenSignature },
    body,
  });
  assert.equal(invalid.nextCalled, false);
  assert.equal(invalid.res.statusCode, 401);
});

test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});
