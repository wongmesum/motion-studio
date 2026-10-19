import fs from 'fs';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * MinIO-compatible subset of the previous SDK, backed by the maintained AWS S3
 * client. Only the operations this project calls are implemented, so swapping the
 * SDK cannot silently change behaviour elsewhere.
 */
export function createObjectStorageClient({ client, signUrl = getSignedUrl }) {
  if (!client) throw new Error('S3 client wajib disediakan');

  return {
    async bucketExists(bucket) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      } catch (error) {
        // A missing bucket surfaces as 404/NotFound; anything else must stay fatal
        // so a credential or network fault is never mistaken for "create it".
        const status = error?.$metadata?.httpStatusCode;
        if (error?.name === 'NotFound' || status === 404) return false;
        throw error;
      }
    },

    async makeBucket(bucket) {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    },

    async fPutObject(bucket, objectName, filePath, metadata = {}) {
      const { size } = await fs.promises.stat(filePath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectName,
          Body: fs.createReadStream(filePath),
          ContentLength: size,
          ContentType: metadata['Content-Type'],
        })
      );
    },

    async presignedGetObject(bucket, objectName, expiresInSec) {
      return signUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectName }), {
        expiresIn: expiresInSec,
      });
    },
  };
}

/**
 * Build the S3 client configuration for a MinIO or S3-compatible endpoint.
 * Credentials are only read from the environment; nothing is defaulted to a known key pair.
 */
export function createObjectStorageConfig(env = process.env) {
  const accessKeyId = env.MINIO_ACCESS_KEY;
  const secretAccessKey = env.MINIO_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('MINIO_ACCESS_KEY dan MINIO_SECRET_KEY wajib diisi');
  }

  const useSsl = env.MINIO_USE_SSL === 'true';
  const endpoint = env.MINIO_ENDPOINT || 'minio';
  const port = Number(env.MINIO_PORT || 9000);

  return {
    endpoint: `${useSsl ? 'https' : 'http'}://${endpoint}:${port}`,
    region: env.MINIO_REGION || 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    // MinIO serves path-style addressing by default.
    forcePathStyle: true,
    // Since v3.729.0 the SDK attaches a CRC32 checksum to every upload, which
    // S3-compatible servers reject with 501/InvalidRequest. AWS itself stays
    // unaffected because it never requires the checksum on these operations.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

export function createDefaultObjectStorageClient() {
  return createObjectStorageClient({ client: new S3Client(createObjectStorageConfig()) });
}
