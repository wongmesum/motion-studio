import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  AssetNotFoundError,
  AssetRejectedError,
  createAssetStore,
  deriveOwnerKey,
} from '../vps-server/studio/asset-store.js';
import { UPLOAD_LIMITS } from '../vps-server/security/upload-policy.js';

const OWNER_SALT = 'asset-salt';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function createStore(overrides = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-assets-'));
  return {
    rootDir,
    store: createAssetStore({
      rootDir,
      ownerSalt: OWNER_SALT,
      probeImage: async () => ({ width: 1, height: 1 }),
      probeVideo: async () => ({ durationSec: 2 }),
      probeAudio: async () => ({ durationSec: 2 }),
      ...overrides,
    }),
  };
}

function upload(overrides = {}) {
  return {
    filename: 'foto.png',
    contentType: 'image/png',
    stream: Readable.from([PNG]),
    ...overrides,
  };
}

async function cleanup(rootDir) {
  await fs.rm(rootDir, { recursive: true, force: true });
}

test('a valid image upload writes the asset and its sidecar', async () => {
  const { store, rootDir } = await createStore();
  try {
    const asset = await store.save('owner-a', upload());

    assert.match(asset.assetId, /^ast_[0-9a-f-]{36}$/);
    assert.equal(asset.kind, 'image');
    assert.equal(asset.mime, 'image/png');
    assert.equal(asset.extension, '.png');
    assert.equal(asset.bytes, PNG.length);
    assert.equal(asset.originalName, 'foto.png');
    assert.equal(asset.width, 1);
    assert.equal(asset.height, 1);

    const ownerDir = path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT));
    const files = (await fs.readdir(ownerDir)).sort();
    assert.deepEqual(files, [`${asset.assetId}.json`, `${asset.assetId}.png`]);

    const stored = await fs.readFile(path.join(ownerDir, `${asset.assetId}.png`));
    assert.deepEqual(stored, PNG);
  } finally {
    await cleanup(rootDir);
  }
});

test('the stored path never derives from the client filename', async () => {
  const { store, rootDir } = await createStore();
  try {
    const asset = await store.save('owner-a', upload({
      filename: '../../../../etc/passwd.png',
      contentType: 'image/png',
    }));

    assert.equal(asset.originalName, 'passwd.png');
    const ownerDir = path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT));
    assert.deepEqual(
      (await fs.readdir(ownerDir)).sort(),
      [`${asset.assetId}.json`, `${asset.assetId}.png`]
    );
  } finally {
    await cleanup(rootDir);
  }
});

test('content type and magic bytes must agree', async () => {
  const { store, rootDir } = await createStore();
  try {
    await assert.rejects(
      () => store.save('owner-a', upload({ contentType: 'image/png', stream: Readable.from([Buffer.from('<?php')]) })),
      (error) => error instanceof AssetRejectedError && /magic/i.test(error.message)
    );
    await assert.rejects(
      () => store.save('owner-a', upload({ contentType: 'text/html' })),
      (error) => error instanceof AssetRejectedError && /tipe|type/i.test(error.message)
    );
  } finally {
    await cleanup(rootDir);
  }
});

test('a failed upload leaves no file or sidecar behind', async () => {
  const { store, rootDir } = await createStore();
  try {
    await assert.rejects(() => store.save('owner-a', upload({ stream: Readable.from([Buffer.from('nope')]) })));

    const ownerDir = path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT));
    const files = await fs.readdir(ownerDir).catch(() => []);
    assert.deepEqual(files, []);
  } finally {
    await cleanup(rootDir);
  }
});

test('stream overrun past the declared limit aborts and cleans up', async () => {
  const { store, rootDir } = await createStore({
    limits: { image: { maxBytes: 16 } },
  });
  try {
    const oversized = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(64)]);
    await assert.rejects(
      () => store.save('owner-a', upload({ stream: Readable.from([oversized]) })),
      (error) => error instanceof AssetRejectedError && /ukuran|size/i.test(error.message)
    );
    assert.deepEqual(
      await fs.readdir(path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT))).catch(() => []),
      []
    );
  } finally {
    await cleanup(rootDir);
  }
});

test('a lying Content-Length is caught before any bytes are read', async () => {
  const { store, rootDir } = await createStore({
    limits: { image: { maxBytes: 16 } },
  });
  try {
    await assert.rejects(
      () => store.save('owner-a', upload({ contentLength: 1024 })),
      (error) => error instanceof AssetRejectedError && /ukuran|size/i.test(error.message)
    );
  } finally {
    await cleanup(rootDir);
  }
});

test('decode probe failures reject the upload', async () => {
  const { store, rootDir } = await createStore({
    probeImage: async () => {
      throw new Error('decode failed');
    },
  });
  try {
    await assert.rejects(
      () => store.save('owner-a', upload()),
      (error) => error instanceof AssetRejectedError && /decode|probe|validasi/i.test(error.message)
    );
    assert.deepEqual(
      await fs.readdir(path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT))).catch(() => []),
      []
    );
  } finally {
    await cleanup(rootDir);
  }
});

test('oversized image dimensions are rejected', async () => {
  const { store, rootDir } = await createStore({
    probeImage: async () => ({ width: UPLOAD_LIMITS.maxImageDimension + 1, height: 10 }),
  });
  try {
    await assert.rejects(
      () => store.save('owner-a', upload()),
      (error) => error instanceof AssetRejectedError && /dimensi|dimension/i.test(error.message)
    );
  } finally {
    await cleanup(rootDir);
  }
});

test('assets are scoped to their owner', async () => {
  const { store, rootDir } = await createStore();
  try {
    const asset = await store.save('owner-a', upload());

    assert.equal(await store.get('owner-b', asset.assetId), null);
    assert.equal(await store.readPath('owner-b', asset.assetId), null);
    await assert.rejects(
      () => store.remove('owner-b', asset.assetId),
      (error) => error instanceof AssetNotFoundError
    );
    assert.ok(await store.get('owner-a', asset.assetId));
  } finally {
    await cleanup(rootDir);
  }
});

test('path-like asset ids never reach the filesystem', async () => {
  const { store, rootDir } = await createStore();
  try {
    for (const assetId of ['../../etc/passwd', 'ast_../../x', 'ast_ZZZ', '', 'ast_' + 'a'.repeat(200)]) {
      assert.equal(await store.get('owner-a', assetId), null, `loaded ${assetId}`);
      assert.equal(await store.readPath('owner-a', assetId), null, `resolved ${assetId}`);
    }
  } finally {
    await cleanup(rootDir);
  }
});

test('list reports usage for the owner only', async () => {
  const { store, rootDir } = await createStore();
  try {
    const first = await store.save('owner-a', upload());
    await store.save('owner-b', upload());

    const listing = await store.list('owner-a');
    assert.equal(listing.assets.length, 1);
    assert.equal(listing.assets[0].assetId, first.assetId);
    assert.equal(listing.usage.count, 1);
    assert.equal(listing.usage.bytes, PNG.length);
  } finally {
    await cleanup(rootDir);
  }
});

test('asset count and byte quotas are enforced', async () => {
  const { store, rootDir } = await createStore({
    limits: { maxAssetsPerOwner: 1, maxOwnerBytes: 10_000 },
  });
  try {
    await store.save('owner-a', upload());
    await assert.rejects(
      () => store.save('owner-a', upload()),
      (error) => error instanceof AssetRejectedError && /kuota|batas|quota/i.test(error.message)
    );

    const bytesStore = createAssetStore({
      rootDir: path.join(rootDir, 'bytes'),
      ownerSalt: OWNER_SALT,
      probeImage: async () => ({ width: 1, height: 1 }),
      limits: { maxOwnerBytes: PNG.length },
    });
    await bytesStore.save('owner-a', upload());
    await assert.rejects(
      () => bytesStore.save('owner-a', upload()),
      (error) => error instanceof AssetRejectedError && /kuota|batas|quota/i.test(error.message)
    );
  } finally {
    await cleanup(rootDir);
  }
});

test('remove deletes both the asset and its sidecar', async () => {
  const { store, rootDir } = await createStore();
  try {
    const asset = await store.save('owner-a', upload());
    await store.remove('owner-a', asset.assetId);

    assert.equal(await store.get('owner-a', asset.assetId), null);
    assert.deepEqual(
      await fs.readdir(path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT))),
      []
    );
    await assert.rejects(
      () => store.remove('owner-a', asset.assetId),
      (error) => error instanceof AssetNotFoundError
    );
  } finally {
    await cleanup(rootDir);
  }
});

test('expired assets are reported and removable through cleanup', async () => {
  const past = new Date('2000-01-01T00:00:00.000Z');
  const { store, rootDir } = await createStore({ now: () => past.toISOString() });
  try {
    await store.save('owner-a', upload());

    const freshStore = createAssetStore({
      rootDir,
      ownerSalt: OWNER_SALT,
      probeImage: async () => ({ width: 1, height: 1 }),
      ttlHours: 1,
    });
    const removed = await freshStore.removeExpired(new Date('2001-01-01T00:00:00.000Z'));
    assert.equal(removed, 1);
    assert.deepEqual(await freshStore.list('owner-a').then((l) => l.assets), []);
  } finally {
    await cleanup(rootDir);
  }
});

test('cleanup keeps assets that are still inside the TTL', async () => {
  const { store, rootDir } = await createStore();
  try {
    await store.save('owner-a', upload());
    const removed = await store.removeExpired(new Date(Date.now() + 60_000), { ttlHours: 72 });
    assert.equal(removed, 0);
    assert.equal((await store.list('owner-a')).assets.length, 1);
  } finally {
    await cleanup(rootDir);
  }
});

test('readPath returns a contained absolute path for a live asset', async () => {
  const { store, rootDir } = await createStore();
  try {
    const asset = await store.save('owner-a', upload());
    const resolved = await store.readPath('owner-a', asset.assetId);

    assert.ok(path.isAbsolute(resolved));
    assert.ok(resolved.startsWith(rootDir + path.sep));
    assert.ok(resolved.endsWith('.png'));
  } finally {
    await cleanup(rootDir);
  }
});

test('assets expired by TTL are not readable', async () => {
  const past = new Date('2000-01-01T00:00:00.000Z');
  const { store, rootDir } = await createStore({
    now: () => past.toISOString(),
    ttlHours: 1,
  });
  try {
    const asset = await store.save('owner-a', upload());
    assert.equal(await store.readPath('owner-a', asset.assetId), null);
    assert.equal(await store.get('owner-a', asset.assetId), null);
  } finally {
    await cleanup(rootDir);
  }
});

test('corrupt sidecars are skipped instead of crashing a listing', async () => {
  const { store, rootDir } = await createStore();
  try {
    const asset = await store.save('owner-a', upload());
    const ownerDir = path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT));
    await fs.writeFile(path.join(ownerDir, 'ast_11111111-1111-4111-8111-111111111111.json'), '{ broken');

    const listing = await store.list('owner-a');
    assert.deepEqual(listing.assets.map((item) => item.assetId), [asset.assetId]);
  } finally {
    await cleanup(rootDir);
  }
});
