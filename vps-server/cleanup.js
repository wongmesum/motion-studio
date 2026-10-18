import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

const TTL_MS = Number(process.env.CLEANUP_TTL_HOURS || 24) * 60 * 60 * 1000;

/**
 * Bersihkan file lama di folder output, cache, dan frames agar disk VPS tidak penuh
 */
export async function runCleanupOnce() {
  const now = Date.now();
  const dirs = ['output', 'cache', 'frames'];
  let removedCount = 0;

  for (const dir of dirs) {
    const dirAbs = path.resolve(process.cwd(), dir);
    try {
      const entries = await fs.readdir(dirAbs);
      for (const name of entries) {
        if (name === '.gitkeep') continue;
        const fullPath = path.join(dirAbs, name);
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs > TTL_MS) {
          await fs.rm(fullPath, { recursive: true, force: true });
          removedCount++;
        }
      }
    } catch {
      // direktori belum ada, abaikan
    }
  }

  if (removedCount > 0) {
    logger.info('TTL Cleanup completed', { removedCount });
  }
  return removedCount;
}

export function startCleanupScheduler() {
  // Jalankan setiap 1 jam
  const interval = setInterval(() => {
    runCleanupOnce().catch((err) => logger.warn('Cleanup error', { error: err.message }));
  }, 60 * 60 * 1000);
  interval.unref?.();
  logger.info('TTL Cleanup scheduler started', { ttlHours: TTL_MS / 3600000 });
}
