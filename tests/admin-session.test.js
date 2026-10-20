import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionCookie,
  createAdminSessionService,
  getSessionToken,
  hashAdminPassword,
  parseCookies,
  verifyAdminPassword,
} from '../vps-server/security/admin-session.js';

class MemorySessionStore {
  records = new Map();
  writes = [];

  async set(key, value, mode, ttl) {
    this.records.set(key, value);
    this.writes.push({ key, value, mode, ttl });
  }

  async get(key) {
    return this.records.get(key) || null;
  }

  async del(key) {
    return this.records.delete(key) ? 1 : 0;
  }
}

test('admin password uses versioned scrypt hash and constant-time verification', async () => {
  const passwordHash = await hashAdminPassword('correct horse battery staple');

  assert.match(passwordHash, /^scrypt\$v1\$/);
  assert.equal(await verifyAdminPassword('correct horse battery staple', passwordHash), true);
  assert.equal(await verifyAdminPassword('wrong password', passwordHash), false);
  assert.equal(await verifyAdminPassword('anything', 'malformed'), false);
});

test('session stores only token digest with eight-hour TTL', async () => {
  const store = new MemorySessionStore();
  const passwordHash = await hashAdminPassword('admin password');
  const service = createAdminSessionService({ store, passwordHash, ttlSeconds: 28_800 });

  const session = await service.createSession('Admin');
  const write = store.writes[0];

  assert.equal(write.mode, 'EX');
  assert.equal(write.ttl, 28_800);
  assert.match(write.key, /^motion:admin-session:[a-f0-9]{64}$/);
  assert.equal(write.key.includes(session.token), false);
  assert.equal(write.value.includes(session.token), false);
  assert.equal(session.csrfToken.length >= 32, true);
});

test('session cookie is HttpOnly, Secure, strict, and scoped to the app', () => {
  const cookie = buildSessionCookie('secret-session-token', { ttlSeconds: 28_800 });

  assert.match(cookie, /^motion_admin_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=28800/);
});

test('password hash change invalidates existing sessions', async () => {
  const store = new MemorySessionStore();
  const firstHash = await hashAdminPassword('first password');
  const firstService = createAdminSessionService({ store, passwordHash: firstHash });
  const created = await firstService.createSession('Admin');

  assert.ok(await firstService.getSession(created.token));

  const secondHash = await hashAdminPassword('second password');
  const secondService = createAdminSessionService({ store, passwordHash: secondHash });
  assert.equal(await secondService.getSession(created.token), null);
});

test('malformed cookie encoding is ignored without throwing', () => {
  assert.doesNotThrow(() => parseCookies('motion_admin_session=%; other=value'));
  assert.equal(getSessionToken('motion_admin_session=%'), '');
  assert.deepEqual(parseCookies('valid=value; malformed=%'), { valid: 'value' });
});

test('CSRF accepts matching session token and rejects missing or wrong values', async () => {
  const store = new MemorySessionStore();
  const passwordHash = await hashAdminPassword('admin password');
  const service = createAdminSessionService({ store, passwordHash });
  const created = await service.createSession('Admin');
  const session = await service.getSession(created.token);

  assert.equal(service.isValidCsrf(session, created.csrfToken), true);
  assert.equal(service.isValidCsrf(session, ''), false);
  assert.equal(service.isValidCsrf(session, 'wrong'), false);
});

test('deleting a session removes its digest record', async () => {
  const store = new MemorySessionStore();
  const passwordHash = await hashAdminPassword('admin password');
  const service = createAdminSessionService({ store, passwordHash });
  const created = await service.createSession('Admin');

  await service.deleteSession(created.token);

  assert.equal(await service.getSession(created.token), null);
});
