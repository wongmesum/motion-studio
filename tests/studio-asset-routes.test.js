import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createStudioRouter } from '../vps-server/studio-routes.js';
import { createAssetStore } from '../vps-server/studio/asset-store.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const SESSION_HEADER = 'X-Test-Session';

function authenticate(req, res, next) {
  if (req.headers[SESSION_HEADER.toLowerCase()] !== 'ok') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.adminActor = 'Studio Admin';
  req.adminSession = { csrfToken: 'csrf-token' };
  next();
}

function requireCsrf(req, res, next) {
  if (req.headers['x-csrf-token'] !== 'csrf-token') {
    return res.status(403).json({ error: 'Token CSRF tidak valid' });
  }
  next();
}

async function startServer(rootDir, { limits } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/studio', createStudioRouter({
    authenticate,
    requireCsrf,
    rateLimit: (_req, _res, next) => next(),
    uploadLimiter: (_req, _res, next) => next(),
    assetStore: createAssetStore({
      rootDir,
      ownerSalt: 'route-salt',
      limits,
      probeImage: async () => ({ width: 1, height: 1 }),
      probeVideo: async () => ({ durationSec: 1 }),
      probeAudio: async () => ({ durationSec: 1 }),
    }),
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function form(fields) {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value instanceof Blob) body.append(name, value, value.name || 'upload.bin');
    else body.append(name, String(value));
  }
  return body;
}

function pngBlob(name = 'foto.png') {
  const blob = new Blob([PNG], { type: 'image/png' });
  blob.name = name;
  return blob;
}

function request(baseUrl, route, options = {}) {
  const headers = { [SESSION_HEADER]: 'ok', ...(options.headers || {}) };
  return fetch(`${baseUrl}${route}`, { ...options, headers });
}

function upload(baseUrl, body, headers = {}) {
  return request(baseUrl, '/api/studio/assets', {
    method: 'POST',
    headers: { 'X-CSRF-Token': 'csrf-token', ...headers },
    body,
  });
}

async function withServer(context, callback, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-asset-routes-'));
  const stack = await startServer(rootDir, options);
  context.after(async () => {
    await stack.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return callback(stack);
}

test('upload requires session and CSRF', async (context) => withServer(context, async (stack) => {
  const noCsrf = await upload(stack.baseUrl, form({ file: pngBlob() }), { 'X-CSRF-Token': '' });
  assert.equal(noCsrf.status, 403);

  const anonymous = await fetch(`${stack.baseUrl}/api/studio/assets`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': 'csrf-token' },
    body: form({ file: pngBlob() }),
  });
  assert.equal(anonymous.status, 401);
}));

test('a valid upload returns 201 and its metadata', async (context) => withServer(context, async (stack) => {
  const response = await upload(stack.baseUrl, form({ file: pngBlob() }));
  assert.equal(response.status, 201);
  const { asset } = await response.json();
  assert.match(asset.assetId, /^ast_/);
  assert.equal(asset.kind, 'image');
  assert.equal(asset.bytes, PNG.length);
  assert.equal(asset.width, 1);
  assert.equal(asset.ownerKey, undefined);

  const listed = await request(stack.baseUrl, '/api/studio/assets');
  assert.equal(listed.status, 200);
  const listing = await listed.json();
  assert.equal(listing.assets.length, 1);
  assert.equal(listing.usage.count, 1);
}));

test('content is streamed inline with hardened headers', async (context) => withServer(context, async (stack) => {
  const { asset } = await (await upload(stack.baseUrl, form({ file: pngBlob() }))).json();
  const response = await request(
    stack.baseUrl,
    `/api/studio/assets/${asset.assetId}/content`
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control'), /private/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
}));

test('download mode and invalid ids behave predictably', async (context) => withServer(context, async (stack) => {
  const { asset } = await (await upload(stack.baseUrl, form({ file: pngBlob() }))).json();
  const download = await request(
    stack.baseUrl,
    `/api/studio/assets/${asset.assetId}/content?download=1`
  );
  assert.match(download.headers.get('content-disposition') || '', /attachment/);

  const anonymous = await fetch(
    `${stack.baseUrl}/api/studio/assets/${asset.assetId}/content`
  );
  assert.equal(anonymous.status, 401);

  for (const assetId of ['ast_ZZZ', '..%2F..%2Fetc%2Fpasswd', 'ast_11111111-1111-4111-8111-111111111111']) {
    const response = await request(stack.baseUrl, `/api/studio/assets/${assetId}/content`);
    assert.equal(response.status, 404, assetId);
  }
}));

test('unsupported types, bad magic bytes and empty bodies are rejected', async (context) => withServer(context, async (stack) => {
  const html = new Blob(['<script>alert(1)</script>'], { type: 'text/html' });
  html.name = 'x.html';
  const unsupported = await upload(stack.baseUrl, form({ file: html }));
  assert.equal(unsupported.status, 415);

  const fake = new Blob([Buffer.from('<?php')], { type: 'image/png' });
  fake.name = 'x.png';
  const mismatch = await upload(stack.baseUrl, form({ file: fake }));
  assert.equal(mismatch.status, 415);

  const empty = await upload(stack.baseUrl, form({}));
  assert.equal(empty.status, 400);

  const wrongField = await upload(stack.baseUrl, form({ other: pngBlob() }));
  assert.equal(wrongField.status, 400);
}));

test('delete removes the asset and reports unknown ids as 404', async (context) => withServer(context, async (stack) => {
  const { asset } = await (await upload(stack.baseUrl, form({ file: pngBlob() }))).json();
  const deleted = await request(stack.baseUrl, `/api/studio/assets/${asset.assetId}`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': 'csrf-token' },
  });
  assert.equal(deleted.status, 200);

  const gone = await request(stack.baseUrl, `/api/studio/assets/${asset.assetId}/content`);
  assert.equal(gone.status, 404);

  const again = await request(stack.baseUrl, `/api/studio/assets/${asset.assetId}`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': 'csrf-token' },
  });
  assert.equal(again.status, 404);
}));

test('server upload limit returns 413 without leaving a stored asset', async (context) => withServer(context, async (stack) => {
  const oversized = new Blob([Buffer.concat([PNG, Buffer.alloc(64)])], { type: 'image/png' });
  oversized.name = 'big.png';
  const response = await upload(stack.baseUrl, form({ file: oversized }));
  assert.equal(response.status, 413);

  const listing = await request(stack.baseUrl, '/api/studio/assets').then((value) => value.json());
  assert.equal(listing.assets.length, 0);
}, { limits: { image: { maxBytes: 16 } } }));

test('client headers cannot lower server upload limits', async (context) => withServer(context, async (stack) => {
  const oversized = new Blob([Buffer.concat([PNG, Buffer.alloc(64)])], { type: 'image/png' });
  oversized.name = 'big.png';
  const response = await upload(stack.baseUrl, form({ file: oversized }), {
    'X-Test-Max-Bytes': '16',
  });
  assert.equal(response.status, 201);
}));
