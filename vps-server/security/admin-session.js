import crypto from 'crypto';
import IORedis from 'ioredis';
import { logger } from '../logger.js';

const HASH_VERSION = 'v1';
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const HASH_BYTES = 64;
const SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const CSRF_TOKEN_BYTES = 24;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE_NAME = 'motion_admin_session';
const SESSION_KEY_PREFIX = 'motion:admin-session:';

function deriveScrypt(password, salt, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, options.keyLength, options, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

export async function hashAdminPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Password admin minimal 12 karakter');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const options = {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    keyLength: HASH_BYTES,
    maxmem: 64 * 1024 * 1024,
  };
  const digest = await deriveScrypt(password, salt, options);
  return [
    'scrypt',
    HASH_VERSION,
    options.N,
    options.r,
    options.p,
    options.keyLength,
    salt.toString('hex'),
    digest.toString('hex'),
  ].join('$');
}

function parsePasswordHash(passwordHash) {
  const parts = String(passwordHash || '').split('$');
  if (parts.length !== 8 || parts[0] !== 'scrypt' || parts[1] !== HASH_VERSION) return null;
  const [N, r, p, keyLength] = parts.slice(2, 6).map(Number);
  const salt = Buffer.from(parts[6], 'hex');
  const digest = Buffer.from(parts[7], 'hex');
  const validParameters = N === SCRYPT_COST
    && r === SCRYPT_BLOCK_SIZE
    && p === SCRYPT_PARALLELIZATION
    && keyLength === HASH_BYTES;
  if (!validParameters || salt.length !== SALT_BYTES || digest.length !== HASH_BYTES) return null;
  return { N, r, p, keyLength, salt, digest, maxmem: 64 * 1024 * 1024 };
}

export async function verifyAdminPassword(password, passwordHash) {
  if (typeof password !== 'string') return false;
  const parsed = parsePasswordHash(passwordHash);
  if (!parsed) return false;
  try {
    const actual = await deriveScrypt(password, parsed.salt, parsed);
    return crypto.timingSafeEqual(actual, parsed.digest);
  } catch {
    return false;
  }
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAdminSessionService({
  store,
  passwordHash,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  now = () => Date.now(),
}) {
  const passwordFingerprint = hashValue(String(passwordHash || ''));
  const getKey = (token) => `${SESSION_KEY_PREFIX}${hashValue(token)}`;

  return {
    isConfigured: Boolean(parsePasswordHash(passwordHash)),
    async verifyPassword(password) {
      return verifyAdminPassword(password, passwordHash);
    },
    async createSession(actor = 'Admin') {
      const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
      const csrfToken = crypto.randomBytes(CSRF_TOKEN_BYTES).toString('hex');
      const createdAt = now();
      const record = {
        actor,
        csrfToken,
        createdAt,
        expiresAt: createdAt + ttlSeconds * 1000,
        passwordFingerprint,
      };
      await store.set(getKey(token), JSON.stringify(record), 'EX', ttlSeconds);
      return { token, csrfToken, ...record };
    },
    async getSession(token) {
      if (typeof token !== 'string' || token.length === 0) return null;
      const key = getKey(token);
      const raw = await store.get(key);
      if (!raw) return null;
      try {
        const record = JSON.parse(raw);
        const valid = record.expiresAt > now()
          && safeEqual(record.passwordFingerprint, passwordFingerprint);
        if (valid) return record;
        await store.del(key);
        return null;
      } catch {
        await store.del(key);
        return null;
      }
    },
    async deleteSession(token) {
      if (typeof token !== 'string' || token.length === 0) return;
      await store.del(getKey(token));
    },
    isValidCsrf(session, csrfToken) {
      return safeEqual(session?.csrfToken, csrfToken);
    },
  };
}

/**
 * Percent decoding is attacker-controlled: a header like `session=%` throws URIError.
 * A malformed pair is dropped instead of failing the whole request, because cookie
 * parsing runs before any route can catch the error.
 */
function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader = '') {
  const pairs = cookieHeader
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf('=');
      if (separator < 0) return [item, ''];
      const value = decodeCookieValue(item.slice(separator + 1));
      return value === null ? null : [item.slice(0, separator), value];
    })
    .filter(Boolean);
  return Object.fromEntries(pairs);
}

export function getSessionToken(cookieHeader = '') {
  return parseCookies(cookieHeader)[SESSION_COOKIE_NAME] || '';
}

export function buildSessionCookie(token, {
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  secure = true,
} = {}) {
  const fields = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${ttlSeconds}`,
  ];
  if (secure) fields.push('Secure');
  return fields.join('; ');
}

export function buildExpiredSessionCookie({ secure = true } = {}) {
  return buildSessionCookie('', { ttlSeconds: 0, secure });
}

let redisStore;
export function getAdminSessionStore(env = process.env) {
  if (redisStore) return redisStore;
  redisStore = new IORedis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1,
    commandTimeout: 5000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout: 3000,
    retryStrategy: (attempt) => Math.min(200 * 2 ** (attempt - 1), 10_000),
  });
  redisStore.on('error', (error) => {
    logger.warn('Admin session Redis error', { error: error.message });
  });
  return redisStore;
}

let adminSessionService = null;

/**
 * Single process-wide service. Creating one per request would open a new Redis
 * client each time and leak connections under polling traffic.
 */
export function getAdminSessionService(env = process.env) {
  if (adminSessionService) return adminSessionService;
  const store = env.REDIS_ENABLED === 'false'
    ? createMemorySessionStore()
    : getAdminSessionStore(env);
  adminSessionService = createAdminSessionService({
    store,
    passwordHash: env.ADMIN_PASSWORD_HASH || '',
    ttlSeconds: Number(env.ADMIN_SESSION_TTL_SEC || DEFAULT_SESSION_TTL_SECONDS),
  });
  return adminSessionService;
}

export function createConfiguredAdminSessionService(env = process.env) {
  return getAdminSessionService(env);
}

export function setAdminSessionServiceForTesting(service) {
  adminSessionService = service;
}

export function createMemorySessionStore() {
  const records = new Map();
  return {
    async set(key, value) {
      records.set(key, value);
      return 'OK';
    },
    async get(key) {
      return records.get(key) ?? null;
    },
    async del(key) {
      return records.delete(key) ? 1 : 0;
    },
  };
}
