import express from 'express';
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  createConfiguredAdminSessionService,
  getSessionToken,
} from './security/admin-session.js';
import { logger } from './logger.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
// scrypt runs on every attempt, so bound the input before it reaches the key derivation.
const MAX_PASSWORD_BYTES = 4096;

function isAcceptablePasswordInput(password) {
  return typeof password === 'string'
    && password.length > 0
    && Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES;
}

function getRequestOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function isSameOrigin(req, publicUrl) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const expected = new URL(publicUrl || getRequestOrigin(req)).origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

export function createSessionRouter({
  sessionService = null,
  createSessionService = createConfiguredAdminSessionService,
  publicUrl = process.env.VPS_PUBLIC_URL,
  cookieSecure = process.env.ADMIN_COOKIE_SECURE !== 'false',
  loginWindowMs = LOGIN_WINDOW_MS,
  loginMaxAttempts = LOGIN_MAX_ATTEMPTS,
  now = () => Date.now(),
} = {}) {
  const router = express.Router();
  const loginAttempts = new Map();
  let resolvedSessionService = sessionService;
  const getSessionService = () => {
    if (!resolvedSessionService) resolvedSessionService = createSessionService();
    return resolvedSessionService;
  };

  router.post('/login', async (req, res) => {
    if (!isSameOrigin(req, publicUrl)) {
      return res.status(403).json({ error: 'Origin login tidak diizinkan' });
    }
    // Service creation opens the Redis client, so it stays inside the failure path that
    // answers 503 rather than escaping as an unhandled rejection.
    let activeSessionService;
    try {
      activeSessionService = getSessionService();
    } catch (error) {
      logger.error('Admin session service unavailable', { error: error.message });
      return res.status(503).json({ error: 'Layanan sesi admin sedang tidak tersedia' });
    }
    if (!activeSessionService.isConfigured) {
      return res.status(503).json({ error: 'Password admin belum dikonfigurasi' });
    }

    const key = req.ip || 'unknown';
    const currentTime = now();
    const previous = loginAttempts.get(key);
    const record = !previous || previous.resetAt <= currentTime
      ? { count: 0, resetAt: currentTime + loginWindowMs }
      : previous;
    record.count += 1;
    loginAttempts.set(key, record);
    if (record.count > loginMaxAttempts) {
      return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi nanti.' });
    }

    try {
      const password = req.body?.password;
      if (!isAcceptablePasswordInput(password)) {
        return res.status(401).json({ error: 'Password tidak valid' });
      }
      const valid = await activeSessionService.verifyPassword(password);
      if (!valid) return res.status(401).json({ error: 'Password tidak valid' });
      loginAttempts.delete(key);
      const session = await activeSessionService.createSession('Admin Dashboard');
      res.setHeader('Set-Cookie', buildSessionCookie(session.token, { secure: cookieSecure }));
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        authenticated: true,
        actor: session.actor,
        expiresAt: session.expiresAt,
        csrfToken: session.csrfToken,
      });
    } catch (error) {
      logger.error('Admin session login failed', { error: error.message });
      return res.status(503).json({ error: 'Layanan sesi admin sedang tidak tersedia' });
    }
  });

  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const activeSessionService = getSessionService();
      const token = getSessionToken(req.headers.cookie || '');
      const session = await activeSessionService.getSession(token);
      if (!session) return res.status(401).json({ authenticated: false });
      return res.json({
        authenticated: true,
        actor: session.actor,
        expiresAt: session.expiresAt,
        csrfToken: session.csrfToken,
      });
    } catch (error) {
      logger.error('Admin session lookup failed', { error: error.message });
      return res.status(503).json({ error: 'Layanan sesi admin sedang tidak tersedia' });
    }
  });

  router.post('/logout', async (req, res) => {
    if (!isSameOrigin(req, publicUrl)) {
      return res.status(403).json({ error: 'Origin logout tidak diizinkan' });
    }
    try {
      const activeSessionService = getSessionService();
      const token = getSessionToken(req.headers.cookie || '');
      const session = await activeSessionService.getSession(token);
      if (!session) return res.status(401).json({ error: 'Sesi admin tidak valid' });
      if (!activeSessionService.isValidCsrf(session, req.headers['x-csrf-token'])) {
        return res.status(403).json({ error: 'Token CSRF tidak valid' });
      }
      await activeSessionService.deleteSession(token);
      res.setHeader('Set-Cookie', buildExpiredSessionCookie({ secure: cookieSecure }));
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ authenticated: false });
    } catch (error) {
      logger.error('Admin session logout failed', { error: error.message });
      return res.status(503).json({ error: 'Layanan sesi admin sedang tidak tersedia' });
    }
  });

  return router;
}
