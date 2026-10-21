import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UPLOAD_LIMITS,
  detectUploadKind,
  normalizeUploadContentType,
  matchesImageMagicBytes,
  matchesVideoMagicBytes,
  assertDeclaredSize,
} from '../vps-server/security/upload-policy.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a', 'ascii');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
]);
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
]);
const MOV = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x14]),
  Buffer.from('ftypqt  ', 'ascii'),
]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]);

test('content types normalize and reject unknown values', () => {
  assert.equal(normalizeUploadContentType('image/png; charset=binary'), 'image/png');
  assert.equal(normalizeUploadContentType('  IMAGE/JPEG '), 'image/jpeg');
  assert.equal(normalizeUploadContentType(''), '');
  assert.equal(normalizeUploadContentType('text/html'), 'text/html');
});

test('kinds map to closed sets and unknown types are rejected', () => {
  assert.equal(detectUploadKind('image/png'), 'image');
  assert.equal(detectUploadKind('video/mp4'), 'video');
  assert.equal(detectUploadKind('audio/mpeg'), 'audio');

  for (const contentType of ['text/html', 'application/pdf', 'image/svg+xml', 'application/octet-stream', '']) {
    assert.throws(() => detectUploadKind(contentType), /tipe|type/i, `accepted ${contentType}`);
  }
});

test('image magic bytes match the declared extension', () => {
  assert.equal(matchesImageMagicBytes(PNG, '.png'), true);
  assert.equal(matchesImageMagicBytes(JPEG, '.jpg'), true);
  assert.equal(matchesImageMagicBytes(GIF, '.gif'), true);
  assert.equal(matchesImageMagicBytes(WEBP, '.webp'), true);

  assert.equal(matchesImageMagicBytes(PNG, '.jpg'), false);
  assert.equal(matchesImageMagicBytes(Buffer.from('<?php echo 1; ?>'), '.png'), false);
  assert.equal(matchesImageMagicBytes(Buffer.alloc(0), '.png'), false);
});

test('video magic bytes accept mp4, mov and webm only', () => {
  assert.equal(matchesVideoMagicBytes(MP4, '.mp4'), true);
  assert.equal(matchesVideoMagicBytes(MOV, '.mov'), true);
  assert.equal(matchesVideoMagicBytes(WEBM, '.webm'), true);

  assert.equal(matchesVideoMagicBytes(MP4, '.webm'), false);
  assert.equal(matchesVideoMagicBytes(Buffer.from('not a video'), '.mp4'), false);
});

test('declared sizes are bounded per kind', () => {
  assert.doesNotThrow(() => assertDeclaredSize('image', 1024));
  assert.throws(() => assertDeclaredSize('image', UPLOAD_LIMITS.image.maxBytes + 1), /ukuran|size/i);
  assert.throws(() => assertDeclaredSize('video', UPLOAD_LIMITS.video.maxBytes + 1), /ukuran|size/i);
  assert.throws(() => assertDeclaredSize('audio', UPLOAD_LIMITS.audio.maxBytes + 1), /ukuran|size/i);
  assert.throws(() => assertDeclaredSize('image', -1), /ukuran|size/i);
  assert.throws(() => assertDeclaredSize('image', Number.NaN), /ukuran|size/i);
  assert.throws(() => assertDeclaredSize('gif', 10), /tipe|type/i);
});

test('limits expose named caps for every kind', () => {
  assert.ok(UPLOAD_LIMITS.image.maxBytes > 0);
  assert.ok(UPLOAD_LIMITS.video.maxBytes >= UPLOAD_LIMITS.image.maxBytes);
  assert.ok(UPLOAD_LIMITS.audio.maxBytes > 0);
  assert.ok(UPLOAD_LIMITS.maxAssetsPerOwner > 0);
  assert.ok(UPLOAD_LIMITS.maxImageDimension > 0);
});
