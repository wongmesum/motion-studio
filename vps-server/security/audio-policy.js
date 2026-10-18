import axios from 'axios';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { resolveFfprobeBinary } from '../ffmpeg.js';
import { AUDIO_LIMITS } from '../middleware/limits.js';
import {
  getAllowedRenderHosts,
  isAllowedRemoteAssetUrl,
} from './network-policy.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac']);
const AUDIO_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/x-aac',
]);

export { AUDIO_LIMITS };

export function detectAudioExtension(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL audio tidak valid');
  }
  const extension = parsed.pathname.match(/\.[A-Za-z0-9]+$/)?.[0]?.toLowerCase() || '';
  if (!AUDIO_EXTENSIONS.has(extension)) {
    throw new Error('Ekstensi audio tidak didukung');
  }
  return extension;
}

export function assertAllowedAudioUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('URL audio wajib diisi');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('URL audio tidak valid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('URL audio wajib memakai HTTPS');
  }
  if (!isAllowedRemoteAssetUrl(parsed.href)) {
    throw new Error('Host audio tidak ada dalam allowlist');
  }
  detectAudioExtension(parsed.href);
  return true;
}

export function isAllowedAudioContentType(contentType) {
  const normalized = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return AUDIO_CONTENT_TYPES.has(normalized);
}

export async function validateLocalAudioPath(rawPath, {
  allowedDirectories = [process.cwd()],
  maxBytes = AUDIO_LIMITS.maxBytes,
} = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('Path audio wajib diisi');
  }
  const resolvedPath = path.resolve(rawPath);
  const isAllowed = allowedDirectories.some((directory) => {
    const relative = path.relative(path.resolve(directory), resolvedPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!isAllowed) {
    throw new Error('Path audio berada di luar direktori yang diizinkan');
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    throw new Error('Ekstensi audio tidak didukung');
  }
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat?.isFile()) throw new Error('File audio tidak ditemukan');
  if (stat.size > maxBytes) {
    throw new Error(`Ukuran audio melebihi batas ${maxBytes} byte`);
  }

  const handle = await fs.open(resolvedPath, 'r');
  try {
    const signature = Buffer.alloc(16);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (!matchesAudioMagicBytes(signature.subarray(0, bytesRead), extension)) {
      throw new Error('Magic bytes audio tidak cocok dengan ekstensi');
    }
  } finally {
    await handle.close();
  }
  return resolvedPath;
}

export function matchesAudioMagicBytes(bytes, extension) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (extension === '.mp3') {
    const hasId3 = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from('ID3'));
    // MPEG audio frame sync. The layer field must be a real layer and the version field
    // must not be the reserved value; that rejects ADTS AAC headers, which share the
    // leading sync bits but always encode layer 0.
    const hasFrameSync = bytes.length >= 2 &&
      bytes[0] === 0xff &&
      (bytes[1] & 0xe0) === 0xe0 &&
      ((bytes[1] >> 1) & 0x03) !== 0x00 &&
      ((bytes[1] >> 3) & 0x03) !== 0x01;
    return hasId3 || hasFrameSync;
  }
  if (extension === '.wav') {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
      bytes.subarray(8, 12).equals(Buffer.from('WAVE'));
  }
  if (extension === '.m4a') {
    return bytes.length >= 12 && bytes.subarray(4, 8).equals(Buffer.from('ftyp'));
  }
  if (extension === '.aac') {
    return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  }
  return false;
}

export function createAudioByteGuard({
  contentLength,
  maxBytes = AUDIO_LIMITS.maxBytes,
} = {}) {
  const declaredBytes = Number(contentLength);
  if (contentLength && (!Number.isFinite(declaredBytes) || declaredBytes < 0)) {
    throw new Error('Content-Length audio tidak valid');
  }
  if (declaredBytes > maxBytes) {
    throw new Error(`Ukuran audio melebihi batas ${maxBytes} byte`);
  }

  let receivedBytes = 0;
  return {
    add(chunk) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        throw new Error(`Ukuran audio melebihi batas ${maxBytes} byte`);
      }
      return receivedBytes;
    },
  };
}

// axios.beforeRedirect signature is (nextRequestOptions, responseDetails): the Location
// header lives on the response, so reading nextRequestOptions.headers would silently no-op.
function validateRedirect(nextRequestOptions = {}, responseDetails = {}) {
  const { protocol, hostname } = nextRequestOptions;
  if (protocol && protocol !== 'https:') {
    throw new Error('URL audio wajib memakai HTTPS');
  }
  if (hostname && !getAllowedRenderHosts().has(String(hostname).toLowerCase())) {
    throw new Error('Host audio tidak ada dalam allowlist');
  }

  const location = responseDetails?.headers?.location;
  if (!location) return;
  const base = hostname ? `${protocol || 'https:'}//${hostname}` : undefined;
  const resolved = base ? new URL(location, base).href : location;
  assertAllowedAudioUrl(resolved);
}

/**
 * Confirm the downloaded bytes are a real, decodable audio file. Magic bytes only
 * prove the header shape, so a truncated or corrupt payload still needs decoding.
 * Returns null when ffprobe is unavailable — the size and magic-byte checks stand.
 */
export function probeAudioDuration(filePath, { probeBinary = null } = {}) {
  return new Promise((resolve, reject) => {
    let binary;
    try {
      binary = probeBinary || resolveFfprobeBinary();
    } catch {
      resolve(null);
      return;
    }

    const probe = spawn(binary, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);

    let stdout = '';
    probe.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    probe.on('error', () => resolve(null));
    probe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('File audio tidak dapat didekode'));
        return;
      }
      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('File audio tidak memuat stream audio yang valid'));
        return;
      }
      resolve(duration);
    });
  });
}

export async function downloadAudioAsset(rawUrl, {
  transport = axios,
  maxBytes = AUDIO_LIMITS.maxBytes,
  timeoutMs = AUDIO_LIMITS.downloadTimeoutMs,
} = {}) {
  assertAllowedAudioUrl(rawUrl);
  const extension = detectAudioExtension(rawUrl);
  const response = await transport.get(rawUrl, {
    responseType: 'stream',
    timeout: timeoutMs,
    maxRedirects: AUDIO_LIMITS.maxRedirects,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    validateStatus: () => true,
    beforeRedirect: validateRedirect,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Unduhan audio gagal: HTTP ${response.status}`);
  }
  if (!isAllowedAudioContentType(response.headers?.['content-type'])) {
    throw new Error('Content-Type audio tidak didukung');
  }

  const guard = createAudioByteGuard({
    contentLength: response.headers?.['content-length'],
    maxBytes,
  });
  const chunks = [];
  for await (const rawChunk of response.data) {
    const chunk = Buffer.from(rawChunk);
    guard.add(chunk);
    chunks.push(chunk);
  }

  const bytes = Buffer.concat(chunks);
  if (!matchesAudioMagicBytes(bytes, extension)) {
    throw new Error('Magic bytes audio tidak cocok dengan ekstensi');
  }
  return { bytes, extension };
}
