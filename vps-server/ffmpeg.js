import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BUNDLED_DIR = path.join(PROJECT_ROOT, 'tools', 'ffmpeg');
const EXECUTABLE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

/**
 * Resolve the FFmpeg binary. An explicit FFMPEG_PATH always wins so deployments can
 * point at a statically built copy without touching PATH.
 */
export function resolveFfmpegBinary() {
  const configured = (process.env.FFMPEG_PATH || '').trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`FFMPEG_PATH does not exist: ${resolved}`);
  }

  const bundled = path.join(BUNDLED_DIR, `ffmpeg${EXECUTABLE_SUFFIX}`);
  if (fs.existsSync(bundled)) return bundled;

  return 'ffmpeg';
}

export function resolveFfprobeBinary() {
  const configured = (process.env.FFPROBE_PATH || '').trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`FFPROBE_PATH does not exist: ${resolved}`);
  }

  const bundled = path.join(BUNDLED_DIR, `ffprobe${EXECUTABLE_SUFFIX}`);
  if (fs.existsSync(bundled)) return bundled;

  return 'ffprobe';
}
