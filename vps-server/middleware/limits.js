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

export const AUDIO_LIMITS = {
  maxBytes: Number(process.env.MAX_AUDIO_BYTES || 25 * 1024 * 1024),
  downloadTimeoutMs: Number(process.env.MAX_AUDIO_DOWNLOAD_MS || 60_000),
  maxRedirects: 3,
};

export function validateJobLimits(job) {
  const duration = Number(job.duration ?? 10);
  const fps = Number(job.fps ?? 60);
  const width = Number(job.width ?? 1920);
  const height = Number(job.height ?? 1080);

  if (duration <= 0 || duration > JOB_LIMITS.maxDuration) {
    throw new Error(`Duration must be between 1s and ${JOB_LIMITS.maxDuration}s`);
  }
  if (fps <= 0 || fps > JOB_LIMITS.maxFps) {
    throw new Error(`FPS must be between 1 and ${JOB_LIMITS.maxFps}`);
  }
  if (width > JOB_LIMITS.maxWidth || height > JOB_LIMITS.maxHeight) {
    throw new Error(`Resolution max is ${JOB_LIMITS.maxWidth}x${JOB_LIMITS.maxHeight}`);
  }
  if (Array.isArray(job.assets) && job.assets.length > JOB_LIMITS.maxAssets) {
    throw new Error(`Assets count max is ${JOB_LIMITS.maxAssets}`);
  }
  if (typeof job.html === 'string' && Buffer.byteLength(job.html, 'utf8') > JOB_LIMITS.maxHtmlSize) {
    throw new Error(`HTML payload exceeds max size (${JOB_LIMITS.maxHtmlSize} bytes)`);
  }
  return true;
}
