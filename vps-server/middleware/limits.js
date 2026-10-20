import { assertAllowedAudioUrl } from '../security/audio-policy.js';
import { AUDIO_LIMITS } from '../security/audio-limits.js';

export { AUDIO_LIMITS };

/**
 * Batas Resource per Job Render (Mencegah OOM / Penyalahgunaan CPU)
 */
export const JOB_LIMITS = {
  maxDuration: Number(process.env.MAX_JOB_DURATION_SEC || 60),
  maxFps: Number(process.env.MAX_JOB_FPS || 120),
  maxWidth: 3840,
  maxHeight: 2160,
  maxAssets: Number(process.env.MAX_ASSETS_COUNT || 20),
  maxHtmlSize: Number(process.env.MAX_HTML_BYTES || 500_000),
  timeoutMs: Number(process.env.JOB_TIMEOUT_MS || 10 * 60 * 1000),
};

const ALLOWED_CODECS = new Set(['h264', 'h265', 'av1', 'nvenc']);

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

export function validateJobLimits(job) {
  const duration = Number(job.duration ?? 10);
  const fps = Number(job.fps ?? 60);
  const width = Number(job.width ?? 1920);
  const height = Number(job.height ?? 1080);
  const codec = String(job.codec ?? 'h264').toLowerCase();

  if (!isFinitePositive(duration) || duration > JOB_LIMITS.maxDuration) {
    throw new Error(`Duration must be between 1s and ${JOB_LIMITS.maxDuration}s`);
  }
  if (!isFinitePositive(fps) || !Number.isInteger(fps) || fps > JOB_LIMITS.maxFps) {
    throw new Error(`FPS must be an integer between 1 and ${JOB_LIMITS.maxFps}`);
  }
  const validResolution = isFinitePositive(width)
    && isFinitePositive(height)
    && Number.isInteger(width)
    && Number.isInteger(height)
    && width <= JOB_LIMITS.maxWidth
    && height <= JOB_LIMITS.maxHeight;
  if (!validResolution) {
    throw new Error(`Resolution must use positive integers up to ${JOB_LIMITS.maxWidth}x${JOB_LIMITS.maxHeight}`);
  }
  if (!ALLOWED_CODECS.has(codec)) {
    throw new Error(`Codec must be one of: ${[...ALLOWED_CODECS].join(', ')}`);
  }
  if (job.audio_url !== undefined && job.audio_url !== null && job.audio_url !== '') {
    if (typeof job.audio_url !== 'string') {
      throw new Error('URL audio wajib berupa string');
    }
    assertAllowedAudioUrl(job.audio_url);
  }
  if (Array.isArray(job.assets) && job.assets.length > JOB_LIMITS.maxAssets) {
    throw new Error(`Assets count max is ${JOB_LIMITS.maxAssets}`);
  }
  if (typeof job.html === 'string' && Buffer.byteLength(job.html, 'utf8') > JOB_LIMITS.maxHtmlSize) {
    throw new Error(`HTML payload exceeds max size (${JOB_LIMITS.maxHtmlSize} bytes)`);
  }
  return true;
}
