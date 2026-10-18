import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { getAssetCachePath, ensureCacheDirs } from './cache.js';
import { logger } from './logger.js';
import { isAllowedRemoteAssetUrl } from './security/network-policy.js';

let sharpModule = null;
async function getSharp() {
  if (sharpModule !== null) return sharpModule;
  try {
    const mod = await import('sharp');
    sharpModule = mod.default || mod;
  } catch {
    sharpModule = false;
  }
  return sharpModule;
}

let minioClient = null;
async function getMinioClient() {
  if (process.env.MINIO_ENABLED !== 'true') return null;
  if (minioClient) return minioClient;
  try {
    const Minio = await import('minio');
    minioClient = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || 'minio',
      port: Number(process.env.MINIO_PORT || 9000),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
      secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    });
    return minioClient;
  } catch (e) {
    logger.warn('MinIO client unavailable, falling back to local output folder', { error: e.message });
    return null;
  }
}

/**
 * Download & optimasi gambar/video asset menggunakan Sharp (dengan deduplikasi cache)
 */
export async function prepareAssets(assetUrls = [], width = 1920, height = 1080) {
  await ensureCacheDirs();
  const prepared = [];

  for (const url of assetUrls) {
    if (!url || typeof url !== 'string') continue;
    if (!isAllowedRemoteAssetUrl(url)) {
      logger.warn('Blocked asset URL outside configured HTTPS allowlist', { url });
      continue;
    }
    const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(url);
    const ext = isVideo ? '.mp4' : '.jpg';
    const cachedPath = getAssetCachePath(url, ext);

    try {
      await fs.access(cachedPath);
      prepared.push({ originalUrl: url, localPath: cachedPath, cached: true });
      continue;
    } catch {
      // belum ada di cache, lanjut download
    }

    try {
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      const buffer = Buffer.from(res.data);

      const sharp = await getSharp();
      if (!isVideo && sharp) {
        await sharp(buffer)
          .resize(width, height, { fit: 'cover' })
          .toFormat('jpeg', { quality: 95 })
          .toFile(cachedPath);
      } else {
        await fs.writeFile(cachedPath, buffer);
      }

      prepared.push({ originalUrl: url, localPath: cachedPath, cached: false });
    } catch (e) {
      logger.warn('Failed to download/process asset, keeping original remote URL', {
        url,
        error: e.message,
      });
      prepared.push({ originalUrl: url, localPath: url, cached: false, fallbackRemote: true });
    }
  }

  return prepared;
}

/**
 * Upload file hasil render MP4 ke MinIO S3 (atau kembalikan URL publik VPS lokal)
 */
export async function publishOutput(jobId, localFilePath) {
  const publicBase = (process.env.VPS_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const fileName = path.basename(localFilePath);
  const client = await getMinioClient();

  if (client) {
    try {
      const bucket = process.env.MINIO_BUCKET || 'motion-assets';
      const exists = await client.bucketExists(bucket);
      if (!exists) {
        await client.makeBucket(bucket);
      }
      const objectName = `outputs/${jobId}/${fileName}`;
      await client.fPutObject(bucket, objectName, localFilePath, {
        'Content-Type': 'video/mp4',
      });
      const expiry = Number(process.env.MINIO_SIGNED_URL_EXPIRY || 86400);
      const signedUrl = await client.presignedGetObject(bucket, objectName, expiry);
      return {
        storage: 'minio_s3',
        url: signedUrl,
        localUrl: `${publicBase}/output/${fileName}`,
      };
    } catch (e) {
      logger.warn('MinIO upload failed, serving from local /output route', { error: e.message });
    }
  }

  return {
    storage: 'local_disk',
    url: `${publicBase}/output/${fileName}`,
    localPath: localFilePath,
  };
}
