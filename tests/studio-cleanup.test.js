import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectReferencedAssetIds, runCleanupOnce } from '../vps-server/cleanup.js';

const REFERENCED_ASSET = 'ast_11111111-1111-4111-8111-111111111111';
const OTHER_ASSET = 'ast_22222222-2222-4222-8222-222222222222';

async function writeProject(rootDir, value) {
  const ownerDir = path.join(rootDir, 'owner-a');
  await fs.mkdir(ownerDir, { recursive: true });
  await fs.writeFile(path.join(ownerDir, 'project.json'), JSON.stringify(value));
}

test('collectReferencedAssetIds scans project elements and ignores invalid files', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-cleanup-projects-'));
  try {
    await writeProject(rootDir, {
      project: {
        audio: { assetId: OTHER_ASSET },
        scenes: [{ elements: [
          { type: 'image', assetId: REFERENCED_ASSET },
          { type: 'text', text: REFERENCED_ASSET },
        ] }],
      },
    });
    await fs.writeFile(path.join(rootDir, 'owner-a', 'broken.json'), '{ broken');

    assert.deepEqual(
      await collectReferencedAssetIds(rootDir),
      new Set([REFERENCED_ASSET, OTHER_ASSET])
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('cleanup passes live project references into asset TTL cleanup', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-cleanup-'));
  const projectRootDir = path.join(rootDir, 'projects');
  await writeProject(projectRootDir, {
    project: {
      audio: { assetId: OTHER_ASSET },
      scenes: [{ elements: [{ type: 'video', assetId: REFERENCED_ASSET }] }],
    },
  });

  const calls = [];
  const assetStore = {
    removeExpired: async (referenceTime, options) => {
      calls.push({ referenceTime, options });
      return 2;
    },
  };

  try {
    const result = await runCleanupOnce({
      now: new Date('2026-10-20T12:00:00.000Z'),
      assetStore,
      projectRootDir,
      cleanupDirs: [],
    });

    assert.equal(result, 2);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].options.referencedAssetIds,
      new Set([REFERENCED_ASSET, OTHER_ASSET])
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
