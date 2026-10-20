import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSessionRouter } from '../vps-server/session-routes.js';

function createFakeSessionService() {
  const session = {
    actor: 'Admin Dashboard',
    csrfToken: 'csrf-test-token',
    expiresAt: Date.now() + 28_800_000,
  };
  let deleted = false;
  return {
    isConfigured: true,
    deleted: () => deleted,
    async verifyPassword(password) {
      return password === 'correct-password';
    },
    async createSession() {
      return { token: 'session-test-token', ...session };
    },
    async getSession(token) {
      return token === 'session-test-token' && !deleted ? session : null;
    },
    isValidCsrf(record, token) {
      return record?.csrfToken === token;
    },
    async deleteSession() {
      deleted = true;
    },
  };
}

async function startSessionServer(options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/session', createSessionRouter({
    publicUrl: 'https://studio.example.com',
    cookieSecure: true,
    ...options,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

function request(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Origin: 'https://studio.example.com',
      ...(options.headers || {}),
    },
  });
}

test('session service stays lazy until a session request arrives', async (context) => {
  const service = createFakeSessionService();
  let factoryCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/session', createSessionRouter({
    sessionService: null,
    createSessionService: () => {
      factoryCalls += 1;
      return service;
    },
  }));

  assert.equal(factoryCalls, 0);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const first = await fetch(`${baseUrl}/api/session`);
  const second = await fetch(`${baseUrl}/api/session`);

  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(factoryCalls, 1);
});

test('password login sets secure session cookie without exposing token', async (context) => {
  const service = createFakeSessionService();
  const { server, baseUrl } = await startSessionServer({ sessionService: service });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(baseUrl, '/api/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.csrfToken, 'csrf-test-token');
  assert.equal(JSON.stringify(payload).includes('session-test-token'), false);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /motion_admin_session=session-test-token/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
});

test('login rejects cross-origin and wrong passwords with generic errors', async (context) => {
  const { server, baseUrl } = await startSessionServer({
    sessionService: createFakeSessionService(),
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const crossOrigin = await fetch(`${baseUrl}/api/session/login`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' }),
  });
  assert.equal(crossOrigin.status, 403);

  const wrong = await request(baseUrl, '/api/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'secret-that-must-not-leak' }),
  });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.text()).includes('secret-that-must-not-leak'), false);
});

test('login rate limiter isolates clients behind one trusted proxy', async (context) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/session', createSessionRouter({
    publicUrl: 'https://studio.example.com',
    sessionService: createFakeSessionService(),
    loginMaxAttempts: 1,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: 'https://studio.example.com', 'Content-Type': 'application/json' };

  const firstClient = await fetch(`${baseUrl}/api/session/login`, {
    method: 'POST', headers: { ...headers, 'X-Forwarded-For': '203.0.113.10' }, body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(firstClient.status, 401);
  const secondClient = await fetch(`${baseUrl}/api/session/login`, {
    method: 'POST', headers: { ...headers, 'X-Forwarded-For': '203.0.113.11' }, body: JSON.stringify({ password: 'correct-password' }),
  });
  assert.equal(secondClient.status, 200);
});

test('login rejects oversized passwords before invoking scrypt verification', async (context) => {
  let verificationCalls = 0;
  const service = {
    ...createFakeSessionService(),
    async verifyPassword() {
      verificationCalls += 1;
      return false;
    },
  };
  const { server, baseUrl } = await startSessionServer({ sessionService: service });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(baseUrl, '/api/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'x'.repeat(4097) }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Password tidak valid' });
  assert.equal(verificationCalls, 0);
});

test('login rate limiter returns 429 after repeated failures', async (context) => {
  const { server, baseUrl } = await startSessionServer({
    sessionService: createFakeSessionService(),
    loginMaxAttempts: 2,
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request(baseUrl, '/api/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(response.status, 401);
  }
  const limited = await request(baseUrl, '/api/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' }),
  });
  assert.equal(limited.status, 429);
});

test('session lookup and logout require valid cookie and CSRF', async (context) => {
  const service = createFakeSessionService();
  const { server, baseUrl } = await startSessionServer({ sessionService: service });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const cookie = 'motion_admin_session=session-test-token';

  const current = await request(baseUrl, '/api/session', { headers: { Cookie: cookie } });
  assert.equal(current.status, 200);
  assert.equal((await current.json()).authenticated, true);

  const missingCsrf = await request(baseUrl, '/api/session/logout', {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(missingCsrf.status, 403);

  const logout = await request(baseUrl, '/api/session/logout', {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': 'csrf-test-token' },
  });
  assert.equal(logout.status, 200);
  assert.equal(service.deleted(), true);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('session service creation failures return 503', async (context) => {
  const { server, baseUrl } = await startSessionServer({
    sessionService: null,
    createSessionService: () => { throw new Error('Redis setup failed'); },
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(baseUrl, '/api/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' }),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Layanan sesi admin sedang tidak tersedia' });
});

test('session store failures return 503 without fallback', async (context) => {
  const failingService = {
    isConfigured: true,
    async verifyPassword() { throw new Error('Redis unavailable'); },
  };
  const { server, baseUrl } = await startSessionServer({ sessionService: failingService });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(baseUrl, '/api/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Layanan sesi admin sedang tidak tersedia' });
});
