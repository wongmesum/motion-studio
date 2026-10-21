import { AUDIO_LIMITS } from './audio-limits.js';
import { matchesAudioMagicBytes } from './audio-policy.js';

const MEBIBYTE = 1024 * 1024;

export const UPLOAD_LIMITS = Object.freeze({
  image: Object.freeze({ maxBytes: Number(process.env.MAX_UPLOAD_IMAGE_BYTES || 15 * MEBIBYTE) }),
  video: Object.freeze({ maxBytes: Number(process.env.MAX_UPLOAD_VIDEO_BYTES || 100 * MEBIBYTE) }),
  audio: Object.freeze({ maxBytes: Number(process.env.MAX_UPLOAD_AUDIO_BYTES || AUDIO_LIMITS.maxBytes) }),
  maxAssetsPerOwner: Number(process.env.MAX_UPLOAD_ASSETS_PER_OWNER || 40),
  maxOwnerBytes: Number(process.env.MAX_UPLOAD_OWNER_BYTES || 500 * MEBIBYTE),
  maxImageDimension: Number(process.env.MAX_UPLOAD_IMAGE_DIMENSION || 8192),
  maxVideoDurationSec: Number(process.env.MAX_UPLOAD_VIDEO_DURATION_SEC || 120),
});

export const UPLOAD_TYPES = Object.freeze({
  'image/jpeg': Object.freeze({ kind: 'image', extension: '.jpg' }),
  'image/png': Object.freeze({ kind: 'image', extension: '.png' }),
  'image/webp': Object.freeze({ kind: 'image', extension: '.webp' }),
  'image/gif': Object.freeze({ kind: 'image', extension: '.gif' }),
  'video/mp4': Object.freeze({ kind: 'video', extension: '.mp4' }),
  'video/webm': Object.freeze({ kind: 'video', extension: '.webm' }),
  'video/quicktime': Object.freeze({ kind: 'video', extension: '.mov' }),
  'audio/mpeg': Object.freeze({ kind: 'audio', extension: '.mp3' }),
  'audio/mp3': Object.freeze({ kind: 'audio', extension: '.mp3' }),
  'audio/wav': Object.freeze({ kind: 'audio', extension: '.wav' }),
  'audio/x-wav': Object.freeze({ kind: 'audio', extension: '.wav' }),
  'audio/mp4': Object.freeze({ kind: 'audio', extension: '.m4a' }),
  'audio/x-m4a': Object.freeze({ kind: 'audio', extension: '.m4a' }),
  'audio/aac': Object.freeze({ kind: 'audio', extension: '.aac' }),
  'audio/x-aac': Object.freeze({ kind: 'audio', extension: '.aac' }),
});

export function normalizeUploadContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

export function getUploadType(contentType) {
  const normalized = normalizeUploadContentType(contentType);
  const uploadType = UPLOAD_TYPES[normalized];
  if (!uploadType) throw new Error('Tipe file upload tidak didukung');
  return { contentType: normalized, ...uploadType };
}

export function detectUploadKind(contentType) {
  return getUploadType(contentType).kind;
}

export function assertDeclaredSize(kind, bytes) {
  const limits = UPLOAD_LIMITS[kind];
  if (!limits) throw new Error('Tipe file upload tidak didukung');
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Ukuran file upload tidak valid');
  if (bytes > limits.maxBytes) {
    throw new Error(`Ukuran ${kind} melebihi batas ${limits.maxBytes} byte`);
  }
}

export function matchesImageMagicBytes(bytes, extension) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (extension === '.jpg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (extension === '.png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }
  if (extension === '.gif') {
    return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  }
  if (extension === '.webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).equals(Buffer.from('RIFF'))
      && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
  }
  return false;
}

export function matchesVideoMagicBytes(bytes, extension) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (extension === '.webm') {
    return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (extension === '.mp4' || extension === '.mov') {
    if (bytes.length < 12 || !bytes.subarray(4, 8).equals(Buffer.from('ftyp'))) return false;
    const brand = bytes.subarray(8, 12).toString('ascii');
    if (extension === '.mov') return brand.startsWith('qt');
    return !brand.startsWith('qt');
  }
  return false;
}

export function matchesUploadMagicBytes(bytes, kind, extension) {
  if (kind === 'image') return matchesImageMagicBytes(bytes, extension);
  if (kind === 'video') return matchesVideoMagicBytes(bytes, extension);
  if (kind === 'audio') return matchesAudioMagicBytes(bytes, extension);
  return false;
}
