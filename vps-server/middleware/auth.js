import crypto from 'crypto';
import {
  getServiceKeys,
  findUserByToken,
  incrementUserQuota,
} from '../config-store.js';
import {
  createConfiguredAdminSessionService,
  getSessionToken,
} from '../security/admin-session.js';

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const DEFAULT_MAX_REQ = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 20);
const buckets = new Map();

/**
 * Perbandingan rahasia constant-time agar tidak bocor lewat timing attack.
 * Panjang berbeda selalu ditolak tanpa membandingkan isi.
 */
export function safeSecretEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Rate Limiter dinamis per Token User / IP
 */
export async function limiter(req, res, next) {
  const token = req.headers['x-token'] || '';
  const user = token ? await findUserByToken(token) : null;
  const maxReq = user?.rateLimitPerMin ? Number(user.rateLimitPerMin) : DEFAULT_MAX_REQ;

  const key = token || req.ip || 'anonymous';
  const now = Date.now();
  const record = buckets.get(key) || { count: 0, resetAt: now + WINDOW_MS };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + WINDOW_MS;
  }

  record.count += 1;
  buckets.set(key, record);

  res.setHeader('X-RateLimit-Limit', String(maxReq));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxReq - record.count)));

  if (record.count > maxReq) {
    return res.status(429).json({
      error: 'Rate limit exceeded. Try again later.',
      retryAfterMs: record.resetAt - now,
    });
  }
  next();
}

/**
 * Validasi Token API (Header X-Token)
 * Mendukung Master VPS_TOKEN maupun Token per-User dari Manajemen User Admin Dashboard.
 */
export async function auth(req, res, next) {
  const serviceKeys = await getServiceKeys();
  const expectedMasterToken = serviceKeys.vpsToken;
  const token = req.headers['x-token'];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: missing X-Token header' });
  }

  // Cek apakah Master Token VPS atau Admin Token
  if (safeSecretEqual(token, expectedMasterToken) || safeSecretEqual(token, serviceKeys.adminToken)) {
    req.authUser = {
      id: 'master_token',
      name: 'Master VPS Token',
      role: 'admin',
      status: 'active',
    };
    return next();
  }

  // Cek apakah token milik salah satu User terdaftar di User Management
  const user = await findUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: invalid X-Token' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({
      error: `Forbidden: user account "${user.email}" is currently ${user.status}`,
    });
  }

  if (req.method === 'POST' && req.path === '/render') {
    if (user.role === 'viewer') {
      return res.status(403).json({
        error: 'Forbidden: viewer role cannot submit new render jobs',
      });
    }
    if (user.quotaUsed >= user.quotaLimit) {
      return res.status(429).json({
        error: `Quota exceeded for user "${user.email}" (${user.quotaUsed}/${user.quotaLimit} renders used)`,
      });
    }
    await incrementUserQuota(user.id);
  }

  req.authUser = user;
  next();
}

/**
 * Validasi Admin untuk endpoint /api/admin/*
 * Wajib X-Admin-Token atau X-Token milik admin/engineer aktif.
 */
export async function adminAuth(req, res, next) {
  const serviceKeys = await getServiceKeys();
  const token = req.headers['x-admin-token'] || req.headers['x-token'] || '';

  if (token) {
    if (
      safeSecretEqual(token, serviceKeys.adminToken) ||
      safeSecretEqual(token, serviceKeys.vpsToken)
    ) {
      req.adminActor = 'Super Admin (Master Token)';
      return next();
    }

    const user = await findUserByToken(token);
    if (
      user &&
      user.status === 'active' &&
      (user.role === 'admin' || user.role === 'engineer')
    ) {
      req.adminActor = `${user.name} (${user.role})`;
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized admin token' });
  }

  // No credential of any kind: answer without touching the session store, so an
  // unauthenticated request never depends on Redis being reachable.
  const sessionToken = getSessionToken(req.headers.cookie || '');
  if (!sessionToken) {
    return res.status(401).json({ error: 'Unauthorized: missing X-Admin-Token header or admin session' });
  }

  try {
    const session = await createConfiguredAdminSessionService().getSession(sessionToken);
    if (!session) {
      return res.status(401).json({ error: 'Sesi admin tidak valid atau sudah berakhir' });
    }
    req.adminActor = session.actor;
    req.adminSession = session;
    req.adminSessionToken = sessionToken;
    return next();
  } catch (error) {
    return res.status(503).json({ error: 'Layanan sesi admin sedang tidak tersedia' });
  }
}

export function requireAdminCsrf(req, res, next) {
  // Header-token clients do not use cookies and keep their existing API contract.
  if (!req.adminSession) return next();
  const service = createConfiguredAdminSessionService();
  if (!service.isValidCsrf(req.adminSession, req.headers['x-csrf-token'])) {
    return res.status(403).json({ error: 'Token CSRF tidak valid' });
  }
  return next();
}

/**
 * Validasi HMAC-SHA256 Signature (Opsional jika REQUIRE_HMAC_SIGNATURE=true)
 */
export async function verifySignature(req, res, next) {
  const serviceKeys = await getServiceKeys();
  const requireHmac =
    serviceKeys.requireHmacSignature || process.env.REQUIRE_HMAC_SIGNATURE === 'true';

  if (!requireHmac) {
    return next();
  }

  const secret = serviceKeys.hmacSecret;
  const sig = req.headers['x-signature'];
  if (!sig) {
    return res.status(401).json({ error: 'Unauthorized: missing X-Signature header' });
  }
  if (!secret) {
    return res.status(503).json({ error: 'HMAC signing is enabled but HMAC_SECRET is not configured' });
  }

  const body = JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');

  if (!safeSecretEqual(sig, expected)) {
    return res.status(401).json({ error: 'Unauthorized: invalid HMAC signature' });
  }
  next();
}
