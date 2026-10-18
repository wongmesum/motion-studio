import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { logger, metrics } from './logger.js';

const CACHE_DIR = path.resolve(process.cwd(), 'cache');
const FRAMES_CACHE_DIR = path.join(CACHE_DIR, 'frames');
const ASSETS_CACHE_DIR = path.join(CACHE_DIR, 'assets');

export async function ensureCacheDirs() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(FRAMES_CACHE_DIR, { recursive: true });
  await fs.mkdir(ASSETS_CACHE_DIR, { recursive: true });
}

/**
 * Buat SHA-256 hash unik dari seluruh parameter job render (Content-Addressable)
 */
export function hashJob(job) {
  const canonical = JSON.stringify({
    html: job.html,
    fps: job.fps || 60,
    duration: job.duration || 10,
    width: job.width || 1920,
    height: job.height || 1080,
    assets: job.assets || [],
    audio_url: job.audio_url || null,
    codec: job.codec || 'h264',
    preview: Boolean(job.preview),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Cek apakah video dengan hash input yang sama sudah pernah dirender
 */
export async function getCachedRender(job) {
  await ensureCacheDirs();
  const hash = hashJob(job);
  const cachedFile = path.join(CACHE_DIR, `${hash}.mp4`);

  try {
    await fs.access(cachedFile);
    metrics.cacheHitsTotal += 1;
    logger.info('Content-addressable cache hit', { hash });
    return { hit: true, hash, path: cachedFile };
  } catch {
    return { hit: false, hash, path: cachedFile };
  }
}

/**
 * Simpan hasil render MP4 ke dalam cache content-addressable
 */
export async function saveRenderToCache(job, mp4FilePath) {
  await ensureCacheDirs();
  const hash = hashJob(job);
  const cachedFile = path.join(CACHE_DIR, `${hash}.mp4`);
  try {
    await fs.copyFile(mp4FilePath, cachedFile);
    return cachedFile;
  } catch (e) {
    logger.warn('Failed to write render cache', { error: e.message });
    return null;
  }
}

/**
 * Hash URL asset untuk deduplikasi download dari Higgsfield
 */
export function getAssetCachePath(url, ext = '.jpg') {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
  return path.join(ASSETS_CACHE_DIR, `asset-${hash}${ext}`);
}
