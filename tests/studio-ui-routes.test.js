import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createStudioRouter } from '../vps-server/studio-routes.js';

function authenticate(req, _res, next) {
  req.adminActor = 'Studio Admin';
  req.adminSession = { csrfToken: 'csrf-token' };
  next();
}

function requireCsrf(_req, _res, next) {
  next();
}

async function startServer(options = {}) {
  const app = express();
  app.use('/api/studio', createStudioRouter({
    authenticate,
    requireCsrf,
    rateLimit: (_req, _res, next) => next(),
    ...options,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function makeAssetsDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-ui-assets-'));
  await fs.writeFile(path.join(dir, 'style.css'), 'body { color: #000; }');
  await fs.writeFile(path.join(dir, 'main.js'), 'console.log("studio");');
  await fs.writeFile(path.join(dir, 'server.js'), 'TOP SECRET');
  return dir;
}

test('ui route serves only allowlisted filenames with explicit types', async (context) => {
  const dir = await makeAssetsDir();
  const stack = await startServer({ uiAssetsDir: dir });
  context.after(async () => {
    await stack.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const css = await fetch(`${stack.baseUrl}/api/studio/ui/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.equal(css.headers.get('cache-control'), 'no-cache');
  assert.equal(await css.text(), 'body { color: #000; }');

  const js = await fetch(`${stack.baseUrl}/api/studio/ui/main.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.equal(js.headers.get('cache-control'), 'no-cache');
});

test('ui route rejects unknown filenames with 404', async (context) => {
  const dir = await makeAssetsDir();
  const stack = await startServer({ uiAssetsDir: dir });
  context.after(async () => {
    await stack.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const unknown = await fetch(`${stack.baseUrl}/api/studio/ui/nope.js`);
  assert.equal(unknown.status, 404);
});

test('ui route rejects path-like or foreign filenames with 404', async (context) => {
  const dir = await makeAssetsDir();
  const stack = await startServer({ uiAssetsDir: dir });
  context.after(async () => {
    await stack.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const filename of ['../server.js', '../../.env', '/etc/passwd', 'a%2Fb.js', 'server.js']) {
    const response = await fetch(`${stack.baseUrl}/api/studio/ui/${encodeURIComponent(filename)}`);
    assert.equal(response.status, 404, `expected 404 for ${filename}`);
  }
});

test('ui modules load unauthenticated so the login shell can boot', async (context) => {
  const dir = await makeAssetsDir();
  const app = express();
  const rejectingAuth = (_req, res) => res.status(401).json({ error: 'Belum login' });
  app.use('/api/studio', createStudioRouter({
    authenticate: rejectingAuth,
    requireCsrf,
    rateLimit: (_req, _res, next) => next(),
    uiAssetsDir: dir,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const css = await fetch(`http://127.0.0.1:${server.address().port}/api/studio/ui/style.css`);
  assert.equal(css.status, 200, 'static css must load before login');
  assert.match(css.headers.get('x-content-type-options'), /nosniff/);

  const js = await fetch(`http://127.0.0.1:${server.address().port}/api/studio/ui/main.js`);
  assert.equal(js.status, 200, 'static js must load before login');

  const protectedRoute = await fetch(`http://127.0.0.1:${server.address().port}/api/studio/templates`);
  assert.equal(protectedRoute.status, 401, 'protected routes stay gated');
});
