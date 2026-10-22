import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOTTIE_CATALOG, findLottie } from '../modules/lottie/catalog.js';

test('curated Lottie catalog is unique and backed by valid local animation JSON', async () => {
  assert.equal(new Set(LOTTIE_CATALOG.map(item => item.id)).size, LOTTIE_CATALOG.length);
  for (const item of LOTTIE_CATALOG) {
    assert.match(item.file, /^[a-z0-9-]+\.json$/);
    assert.equal(findLottie(item.id), item);
    const raw = await fs.readFile(path.resolve('modules/lottie/assets', item.file), 'utf8');
    const animation = JSON.parse(raw);
    assert.ok(animation.fr > 0 && animation.op > animation.ip);
    assert.ok(Array.isArray(animation.layers) && animation.layers.length > 0);
  }
  assert.equal(findLottie('../../secret'), null);
  assert.equal(findLottie('https://example.com/evil.json'), null);
});
