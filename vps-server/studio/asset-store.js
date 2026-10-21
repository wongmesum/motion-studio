import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveFfprobeBinary } from '../ffmpeg.js';
import {
  UPLOAD_LIMITS,
  assertDeclaredSize,
  getUploadType,
  matchesUploadMagicBytes,
} from '../security/upload-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT_DIR = path.resolve(__dirname, '../data/uploads');
const OWNER_KEY_LENGTH = 24;
const MAGIC_BYTE_SAMPLE = 32;
const SIDECAR_SUFFIX = '.json';
const ASSET_ID_PATTERN = /^ast_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_KEY_PATTERN = /^[0-9a-f]{24}$/;
const FILE_MODE = 0o600;

export class AssetNotFoundError extends Error {
  constructor() {
    super('Aset tidak ditemukan');
    this.name = 'AssetNotFoundError';
  }
}

export class AssetRejectedError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'AssetRejectedError';
    this.status = status;
  }
}

export function deriveOwnerKey(actor, ownerSalt) {
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new AssetRejectedError('Identitas pemilik tidak valid');
  }
  return crypto
    .createHash('sha256')
    .update(`${ownerSalt} ${actor}`)
    .digest('hex')
    .slice(0, OWNER_KEY_LENGTH);
}

/**
 * Client filenames are display metadata only: strip every directory component so a
 * traversal attempt cannot influence what gets stored or shown.
 */
function toDisplayName(filename) {
  const base = path.basename(String(filename || '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 200);
  return cleaned || 'asset';
}

function resolveContained(rootDir, ...segments) {
  const target = path.resolve(rootDir, ...segments);
  if (target !== path.resolve(rootDir) && !target.startsWith(path.resolve(rootDir) + path.sep)) {
    throw new AssetRejectedError('Path aset tidak valid');
  }
  return target;
}

async function writeAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, { mode: FILE_MODE });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function probeWithFfprobe(filePath, args) {
  return new Promise((resolve) => {
    let binary;
    try {
      binary = resolveFfprobeBinary();
    } catch {
      resolve(null);
      return;
    }
    const probe = spawn(binary, [...args, filePath]);
    let output = '';
    probe.stdout.on('data', (chunk) => { output += chunk; });
    probe.on('error', () => resolve(null));
    probe.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const parsed = Number.parseFloat(output.trim());
      resolve(Number.isFinite(parsed) ? parsed : null);
    });
  });
}

export function probeVideoMetadata(filePath) {
  return probeWithFfprobe(filePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
  ]).then((durationSec) => (durationSec === null ? null : { durationSec }));
}

export function probeAudioMetadata(filePath) {
  return probeWithFfprobe(filePath, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
  ]).then((durationSec) => (durationSec === null ? null : { durationSec }));
}

export function probeImageMetadata(filePath) {
  return import('sharp')
    .then(({ default: sharp }) => sharp(filePath).metadata())
    .then((metadata) => ({ width: metadata.width, height: metadata.height }))
    .catch(() => null);
}

/** Drain the upload into a temporary file, enforcing the byte ceiling as chunks arrive. */
async function writeStreamToTemp(stream, temporaryPath, maxBytes) {
  const handle = await fs.open(temporaryPath, 'wx', FILE_MODE);
  let bytes = 0;
  let exceededLimit = false;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // Keep draining: stopping an async iterator early destroys the Busboy file stream
        // and prevents the multipart parser from emitting `close` and sending its 413.
        exceededLimit = true;
        continue;
      }
      await handle.write(chunk);
    }
    if (exceededLimit) {
      throw new AssetRejectedError(`Ukuran file melebihi batas ${maxBytes} byte`, { status: 413 });
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return bytes;
}

async function readSampleBytes(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const sample = Buffer.alloc(MAGIC_BYTE_SAMPLE);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function createAssetStore({
  rootDir = DEFAULT_ROOT_DIR,
  ownerSalt = process.env.STUDIO_OWNER_SALT || '',
  limits: limitOverrides = {},
  ttlHours = Number(process.env.UPLOAD_TTL_HOURS || 72),
  now = () => new Date().toISOString(),
  probeImage = probeImageMetadata,
  probeVideo = probeVideoMetadata,
  probeAudio = probeAudioMetadata,
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  // Tests override individual caps; every unspecified cap keeps its production default.
  const limits = {
    ...UPLOAD_LIMITS,
    ...limitOverrides,
    image: { ...UPLOAD_LIMITS.image, ...(limitOverrides.image || {}) },
    video: { ...UPLOAD_LIMITS.video, ...(limitOverrides.video || {}) },
    audio: { ...UPLOAD_LIMITS.audio, ...(limitOverrides.audio || {}) },
  };

  function ownerDir(ownerKey) {
    if (!OWNER_KEY_PATTERN.test(ownerKey)) throw new AssetRejectedError('Kunci pemilik tidak valid');
    return resolveContained(resolvedRoot, ownerKey);
  }

  function isExpired(record, referenceTime) {
    const created = Date.parse(record.createdAt);
    if (!Number.isFinite(created)) return true;
    return referenceTime - created > ttlHours * 60 * 60 * 1000;
  }

  async function readRecord(ownerKey, assetId) {
    if (!ASSET_ID_PATTERN.test(String(assetId || ''))) return null;
    let raw;
    try {
      raw = await fs.readFile(ownerDir(ownerKey) + path.sep + `${assetId}${SIDECAR_SUFFIX}`, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function ownerUsage(ownerKey) {
    const directory = ownerDir(ownerKey);
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      return { count: 0, bytes: 0 };
    }
    let count = 0;
    let bytes = 0;
    for (const name of names) {
      if (!name.endsWith(SIDECAR_SUFFIX) || name.endsWith('.tmp')) continue;
      const record = await readRecord(ownerKey, name.slice(0, -SIDECAR_SUFFIX.length));
      if (!record) continue;
      count += 1;
      bytes += Number(record.bytes) || 0;
    }
    return { count, bytes };
  }

  async function assertQuota(ownerKey, incomingBytes) {
    if (!limits.maxAssetsPerOwner && !limits.maxOwnerBytes) return;
    const usage = await ownerUsage(ownerKey);
    if (limits.maxAssetsPerOwner && usage.count + 1 > limits.maxAssetsPerOwner) {
      throw new AssetRejectedError('Kuota jumlah aset sudah penuh');
    }
    if (limits.maxOwnerBytes && usage.bytes + incomingBytes > limits.maxOwnerBytes) {
      throw new AssetRejectedError('Kuota penyimpanan aset sudah penuh');
    }
  }

  async function assertDecodable(kind, filePath, asset) {
    if (kind === 'image') {
      const metadata = await probeImage(filePath);
      if (!metadata || !metadata.width || !metadata.height) {
        throw new AssetRejectedError('Gambar tidak dapat didekode');
      }
      if (metadata.width > limits.maxImageDimension || metadata.height > limits.maxImageDimension) {
        throw new AssetRejectedError(`Dimensi gambar melebihi batas ${limits.maxImageDimension} piksel`);
      }
      asset.width = metadata.width;
      asset.height = metadata.height;
      return;
    }

    const probe = kind === 'video' ? probeVideo : probeAudio;
    const metadata = await probe(filePath);
    if (metadata) {
      if (!Number.isFinite(metadata.durationSec)) {
        throw new AssetRejectedError('Durasi media tidak dapat dibaca');
      }
      if (kind === 'video' && metadata.durationSec > limits.maxVideoDurationSec) {
        throw new AssetRejectedError(`Durasi video melebihi batas ${limits.maxVideoDurationSec} detik`);
      }
      asset.durationSec = metadata.durationSec;
    }
    // ffprobe may be unavailable in a container; size and magic bytes still hold.
  }

  async function save(actor, { filename, contentType, stream, contentLength } = {}) {
    const ownerKey = deriveOwnerKey(actor, ownerSalt);
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new AssetRejectedError('Berkas upload tidak valid');
    }

    let uploadType;
    try {
      uploadType = getUploadType(contentType);
    } catch (error) {
      throw new AssetRejectedError(error.message, { status: 415 });
    }
    const maxBytes = limits[uploadType.kind].maxBytes;
    if (contentLength !== undefined && contentLength !== null && contentLength !== '') {
      try {
        assertDeclaredSize(uploadType.kind, Number(contentLength));
      } catch (error) {
        throw new AssetRejectedError(error.message, { status: 413 });
      }
    }

    const directory = ownerDir(ownerKey);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    const assetId = `ast_${crypto.randomUUID()}`;
    const finalPath = resolveContained(resolvedRoot, ownerKey, `${assetId}${uploadType.extension}`);
    const temporaryPath = resolveContained(
      resolvedRoot, ownerKey, `${assetId}.${crypto.randomUUID()}.part`
    );

    let bytes;
    try {
      bytes = await writeStreamToTemp(stream, temporaryPath, maxBytes);
      if (bytes === 0) throw new AssetRejectedError('Berkas upload kosong');

      const sample = await readSampleBytes(temporaryPath);
      if (!matchesUploadMagicBytes(sample, uploadType.kind, uploadType.extension)) {
        throw new AssetRejectedError(
          'Magic bytes file tidak cocok dengan tipe yang dideklarasikan',
          { status: 415 }
        );
      }

      await assertQuota(ownerKey, bytes);

      const asset = {
        assetId,
        ownerKey,
        kind: uploadType.kind,
        mime: uploadType.contentType,
        extension: uploadType.extension,
        bytes,
        originalName: toDisplayName(filename),
        createdAt: now(),
      };
      await assertDecodable(uploadType.kind, temporaryPath, asset);

      await fs.rename(temporaryPath, finalPath);
      // The sidecar is written only after the bytes are published, so a reader never
      // sees metadata for a file that does not exist yet.
      await writeAtomic(
        resolveContained(resolvedRoot, ownerKey, `${assetId}${SIDECAR_SUFFIX}`),
        JSON.stringify(asset)
      );
      return asset;
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      await fs.rm(finalPath, { force: true }).catch(() => {});
      throw error instanceof AssetRejectedError
        ? error
        : new AssetRejectedError(`Upload gagal: ${error.message}`);
    }
  }

  return {
    async save(actor, upload) {
      return save(actor, upload);
    },

    async get(actor, assetId, { referenceTime = Date.now() } = {}) {
      const ownerKey = deriveOwnerKey(actor, ownerSalt);
      const record = await readRecord(ownerKey, assetId);
      if (!record) return null;
      return isExpired(record, referenceTime) ? null : record;
    },

    async list(actor, { referenceTime = Date.now() } = {}) {
      const ownerKey = deriveOwnerKey(actor, ownerSalt);
      let names;
      try {
        names = await fs.readdir(ownerDir(ownerKey));
      } catch {
        return { assets: [], usage: { count: 0, bytes: 0 } };
      }

      const assets = [];
      let bytes = 0;
      for (const name of names) {
        if (!name.endsWith(SIDECAR_SUFFIX) || name.endsWith('.tmp')) continue;
        const record = await readRecord(ownerKey, name.slice(0, -SIDECAR_SUFFIX.length));
        if (!record || isExpired(record, referenceTime)) continue;
        assets.push(record);
        bytes += Number(record.bytes) || 0;
      }
      assets.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      return { assets, usage: { count: assets.length, bytes } };
    },

    async readPath(actor, assetId, options = {}) {
      const record = await this.get(actor, assetId, options);
      if (!record) return null;
      const filePath = resolveContained(
        resolvedRoot, record.ownerKey, `${record.assetId}${record.extension}`
      );
      const stat = await fs.stat(filePath).catch(() => null);
      return stat?.isFile() ? filePath : null;
    },

    async remove(actor, assetId) {
      const ownerKey = deriveOwnerKey(actor, ownerSalt);
      const record = await readRecord(ownerKey, assetId);
      if (!record) throw new AssetNotFoundError();
      await fs.rm(resolveContained(resolvedRoot, ownerKey, `${assetId}${record.extension}`), { force: true });
      await fs.rm(resolveContained(resolvedRoot, ownerKey, `${assetId}${SIDECAR_SUFFIX}`), { force: true });
    },

    async removeExpired(
      referenceTime = new Date(),
      { ttlHours: overrideTtl, referencedAssetIds = new Set() } = {}
    ) {
      const cutoffHours = overrideTtl === undefined ? ttlHours : overrideTtl;
      const referenceMs = referenceTime instanceof Date ? referenceTime.getTime() : Number(referenceTime);
      let owners;
      try {
        owners = await fs.readdir(resolvedRoot);
      } catch {
        return 0;
      }

      let removed = 0;
      for (const ownerKey of owners) {
        if (!OWNER_KEY_PATTERN.test(ownerKey)) continue;
        const names = await fs.readdir(path.join(resolvedRoot, ownerKey)).catch(() => []);
        for (const name of names) {
          if (!name.endsWith(SIDECAR_SUFFIX)) continue;
          const assetId = name.slice(0, -SIDECAR_SUFFIX.length);
          // A project draft can outlive the upload TTL; deleting a referenced asset would
          // break a saved project, so only orphaned uploads are swept.
          if (referencedAssetIds.has(assetId)) continue;
          const record = await readRecord(ownerKey, assetId);
          const created = Date.parse(record?.createdAt || '');
          const expired = !Number.isFinite(created)
            || referenceMs - created > cutoffHours * 60 * 60 * 1000;
          if (!expired) continue;
          const extension = record?.extension || '';
          await fs.rm(path.join(resolvedRoot, ownerKey, `${assetId}${extension}`), { force: true });
          await fs.rm(path.join(resolvedRoot, ownerKey, name), { force: true });
          removed += 1;
        }
      }
      return removed;
    },
  };
}
