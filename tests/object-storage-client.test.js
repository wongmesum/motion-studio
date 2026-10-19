import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  createObjectStorageClient,
  createObjectStorageConfig,
} from '../vps-server/object-storage-client.js';

function createMockClient(responses = []) {
  const commands = [];
  return {
    commands,
    send: async (command) => {
      commands.push(command);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response || {};
    },
  };
}

test('object storage config stays compatible with MinIO checksum support', () => {
  const config = createObjectStorageConfig({
    MINIO_ACCESS_KEY: 'access',
    MINIO_SECRET_KEY: 'secret',
    MINIO_ENDPOINT: 'minio',
    MINIO_PORT: '9000',
    MINIO_USE_SSL: 'false',
  });

  assert.equal(config.endpoint, 'http://minio:9000');
  assert.equal(config.forcePathStyle, true);
  assert.equal(config.requestChecksumCalculation, 'WHEN_REQUIRED');
  assert.equal(config.responseChecksumValidation, 'WHEN_REQUIRED');
});

test('object storage adapter maps bucket operations to S3 commands', async () => {
  const client = createMockClient([{}, {}, {}]);
  const storage = createObjectStorageClient({ client });

  assert.equal(await storage.bucketExists('motion-assets'), true);
  await storage.makeBucket('motion-assets');

  assert.equal(client.commands[0].constructor.name, HeadBucketCommand.name);
  assert.deepEqual(client.commands[0].input, { Bucket: 'motion-assets' });
  assert.equal(client.commands[1].constructor.name, CreateBucketCommand.name);
  assert.deepEqual(client.commands[1].input, { Bucket: 'motion-assets' });
});

test('object storage adapter treats only missing buckets as absent', async () => {
  const missing = Object.assign(new Error('missing'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
  const denied = Object.assign(new Error('denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });

  assert.equal(await createObjectStorageClient({ client: createMockClient([missing]) })
    .bucketExists('missing'), false);
  await assert.rejects(
    createObjectStorageClient({ client: createMockClient([denied]) }).bucketExists('private'),
    /denied/
  );
});

test('object storage adapter streams uploads and creates signed URLs', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-s3-'));
  const source = path.join(sandbox, 'render.mp4');
  await fs.writeFile(source, Buffer.from('video'));

  const client = createMockClient([{}]);
  const signed = [];
  const storage = createObjectStorageClient({
    client,
    signUrl: async (usedClient, command, options) => {
      signed.push({ usedClient, command, options });
      return 'https://storage.example.test/signed';
    },
  });

  await storage.fPutObject('motion-assets', 'outputs/job/render.mp4', source, {
    'Content-Type': 'video/mp4',
  });
  const url = await storage.presignedGetObject('motion-assets', 'outputs/job/render.mp4', 900);

  const upload = client.commands[0];
  assert.equal(upload.constructor.name, PutObjectCommand.name);
  assert.ok(upload.input.Body instanceof Readable);
  assert.equal(upload.input.ContentLength, 5);
  assert.equal(upload.input.ContentType, 'video/mp4');
  assert.equal(url, 'https://storage.example.test/signed');
  assert.equal(signed[0].command.constructor.name, GetObjectCommand.name);
  assert.equal(signed[0].options.expiresIn, 900);

  upload.input.Body.destroy();
  await fs.rm(sandbox, { recursive: true, force: true });
});
