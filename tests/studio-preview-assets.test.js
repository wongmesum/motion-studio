import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createStudioRouter } from '../vps-server/studio-routes.js';
import {
  buildSignedPreviewAssetUrl,
  verifyPreviewAssetRequest,
} from '../vps-server/studio/preview-assets.js';

const ASSET_ID = 'ast_55555555-5555-4555-8555-555555555555';
const ACTOR = 'Studio Admin';
const SECRET = 'test-preview-secret-at-least-32-characters';
const NOW = 1_800_000_000_000;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function writeTinyPng() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-preview-asset-'));
  const filePath = path.join(dir, 'tiny.png');
  await fs.writeFile(filePath, TINY_PNG);
  return { dir, filePath };
}

function rejectingAuth(_req, res) {
  return res.status(401).json({ error: 'Belum login' });
}

test('preview asset signatures bind asset, actor, and expiry', () => {
  const url = buildSignedPreviewAssetUrl({
    assetId: ASSET_ID,
    actor: ACTOR,
    secret: SECRET,
    now: NOW,
  });
  const parsed = new URL(url, 'https://studio.test');

  assert.equal(parsed.pathname, `/api/studio/preview-assets/${ASSET_ID}/content`);
  assert.equal(verifyPreviewAssetRequest({
    assetId: ASSET_ID,
    actor: parsed.searchParams.get('actor'),
    expires: parsed.searchParams.get('expires'),
    signature: parsed.searchParams.get('signature'),
    secret: SECRET,
    now: NOW + 1_000,
  }), ACTOR);

  assert.equal(verifyPreviewAssetRequest({
    assetId: 'ast_66666666-6666-4666-8666-666666666666',
    actor: parsed.searchParams.get('actor'),
    expires: parsed.searchParams.get('expires'),
    signature: parsed.searchParams.get('signature'),
    secret: SECRET,
    now: NOW + 1_000,
  }), null);

  assert.equal(verifyPreviewAssetRequest({
    assetId: ASSET_ID,
    actor: parsed.searchParams.get('actor'),
    expires: parsed.searchParams.get('expires'),
    signature: parsed.searchParams.get('signature'),
    secret: SECRET,
    now: NOW + 600_000,
  }), null);
});

test('an empty preview secret never verifies any signature', () => {
  // A deployment without an HMAC secret must fail closed instead of accepting URLs
  // signed with an empty key, which anyone could reproduce.
  const parsed = new URL(
    buildSignedPreviewAssetUrl({ assetId: ASSET_ID, actor: ACTOR, secret: '', now: NOW }),
    'https://studio.test'
  );

  assert.equal(verifyPreviewAssetRequest({
    assetId: ASSET_ID,
    actor: parsed.searchParams.get('actor'),
    expires: parsed.searchParams.get('expires'),
    signature: parsed.searchParams.get('signature'),
    secret: '',
    now: NOW + 1_000,
  }), null);
});

test('signed preview asset route works without session while other assets stay protected', async (context) => {
  const { dir, filePath } = await writeTinyPng();
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const asset = {
    assetId: ASSET_ID,
    mime: 'image/png',
    originalName: 'kopi.png',
    extension: '.png',
  };
  const assetStore = {
    get: async (actor, assetId) => actor === ACTOR && assetId === ASSET_ID ? asset : null,
    readPath: async (actor, assetId) => actor === ACTOR && assetId === ASSET_ID
      ? filePath
      : null,
  };
  const app = express();
  app.use('/api/studio', createStudioRouter({
    authenticate: rejectingAuth,
    assetStore,
    getPreviewSecret: async () => SECRET,
    now: () => NOW,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const signedPath = buildSignedPreviewAssetUrl({
    assetId: ASSET_ID,
    actor: ACTOR,
    secret: SECRET,
    now: NOW,
  });

  const signed = await fetch(`${baseUrl}${signedPath}`);
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.get('x-content-type-options'), 'nosniff');

  const unsigned = await fetch(`${baseUrl}/api/studio/preview-assets/${ASSET_ID}/content`);
  assert.equal(unsigned.status, 404);

  const protectedAsset = await fetch(`${baseUrl}/api/studio/assets/${ASSET_ID}/content`);
  assert.equal(protectedAsset.status, 401);
});
