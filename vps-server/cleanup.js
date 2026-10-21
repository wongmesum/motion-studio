import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { createAssetStore } from './studio/asset-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTL_MS = Number(process.env.CLEANUP_TTL_HOURS || 24) * 60 * 60 * 1000;
const PROJECT_ROOT_DIR = path.resolve(__dirname, 'data/studio-projects');
const CLEANUP_DIRS = ['output', 'cache', 'frames'];
const ASSET_ID_PATTERN = /^ast_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const defaultAssetStore = createAssetStore();

function addProjectReferences(value, references) {
  const audioAssetId = value?.project?.audio?.assetId;
  if (ASSET_ID_PATTERN.test(String(audioAssetId || ''))) {
    references.add(audioAssetId);
  }

  const scenes = Array.isArray(value?.project?.scenes) ? value.project.scenes : [];
  for (const scene of scenes) {
    const elements = Array.isArray(scene?.elements) ? scene.elements : [];
    for (const element of elements) {
      if (ASSET_ID_PATTERN.test(String(element?.assetId || ''))) {
        references.add(element.assetId);
      }
    }
  }
}

/** Scan only valid project records; corrupt or temporary files cannot block cleanup. */
export async function collectReferencedAssetIds(projectRootDir = PROJECT_ROOT_DIR) {
  const references = new Set();
  const owners = await fs.readdir(projectRootDir).catch(() => []);
  for (const owner of owners) {
    const ownerPath = path.join(projectRootDir, owner);
    const entries = await fs.readdir(ownerPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(ownerPath, entry.name), 'utf8');
        addProjectReferences(JSON.parse(raw), references);
      } catch {
        // Corrupt project records are ignored; project-store surfaces them to the owner.
      }
    }
  }
  return references;
}

async function cleanGenericDirectories(nowMs, cleanupDirs) {
  let removedCount = 0;
  for (const directory of cleanupDirs) {
    const absolutePath = path.resolve(process.cwd(), directory);
    const entries = await fs.readdir(absolutePath).catch(() => []);
    for (const name of entries) {
      if (name === '.gitkeep') continue;
      const fullPath = path.join(absolutePath, name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat && nowMs - stat.mtimeMs > TTL_MS) {
        await fs.rm(fullPath, { recursive: true, force: true });
        removedCount += 1;
      }
    }
  }
  return removedCount;
}

/** Bersihkan output umum dan upload aset orphan yang melewati TTL. */
export async function runCleanupOnce({
  now = new Date(),
  assetStore = defaultAssetStore,
  projectRootDir = PROJECT_ROOT_DIR,
  cleanupDirs = CLEANUP_DIRS,
} = {}) {
  const referenceTime = now instanceof Date ? now : new Date(now);
  const referencedAssetIds = await collectReferencedAssetIds(projectRootDir);
  const [genericRemoved, assetsRemoved] = await Promise.all([
    cleanGenericDirectories(referenceTime.getTime(), cleanupDirs),
    assetStore.removeExpired(referenceTime, { referencedAssetIds }),
  ]);
  const removedCount = genericRemoved + assetsRemoved;

  if (removedCount > 0) {
    logger.info('TTL Cleanup completed', { removedCount, assetsRemoved });
  }
  return removedCount;
}

export function startCleanupScheduler() {
  const interval = setInterval(() => {
    runCleanupOnce().catch((error) => logger.warn('Cleanup error', { error: error.message }));
  }, 60 * 60 * 1000);
  interval.unref?.();
  logger.info('TTL Cleanup scheduler started', {
    ttlHours: TTL_MS / 3600000,
    uploadTtlHours: Number(process.env.UPLOAD_TTL_HOURS || 72),
  });
}
