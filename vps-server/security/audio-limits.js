/**
 * Batas unduhan audio. Dipisah dari middleware/limits.js agar audio-policy.js dapat
 * memakainya tanpa membuat siklus import (limits.js -> audio-policy.js -> limits.js).
 */
export const AUDIO_LIMITS = {
  maxBytes: Number(process.env.MAX_AUDIO_BYTES || 25 * 1024 * 1024),
  downloadTimeoutMs: Number(process.env.MAX_AUDIO_DOWNLOAD_MS || 60_000),
  maxRedirects: 3,
};
