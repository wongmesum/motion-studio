import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.RENDER_ALLOWED_HOSTS = 'cdn.jsdelivr.net,assets.example.com';
process.env.MAX_AUDIO_BYTES = '1024';
process.env.MAX_AUDIO_DOWNLOAD_MS = '5000';

const ORIGINAL_CWD = process.cwd();

const {
  AUDIO_LIMITS,
  assertAllowedAudioUrl,
  detectAudioExtension,
  isAllowedAudioContentType,
  matchesAudioMagicBytes,
  createAudioByteGuard,
  downloadAudioAsset,
  validateLocalAudioPath,
} = await import('../vps-server/security/audio-policy.js');

const { buildAudioInputArgs } = await import('../vps-server/renderer-args.js');

const MP3_BYTES = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 0)]);
const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)]);
const M4A_BYTES = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(16)]);
const AAC_BYTES = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(16)]);

function createStreamTransport({ chunks, headers = {}, status = 200, redirects = [] }) {
  const calls = [];
  return {
    calls,
    get: async (url, options = {}) => {
      calls.push({ url, options });
      for (const hop of redirects) {
        const target = new URL(hop.headers.location, url);
        options.beforeRedirect?.(
          { protocol: target.protocol, hostname: target.hostname },
          { headers: hop.headers }
        );
      }
      const data = (async function* streamChunks() {
        for (const chunk of chunks) yield chunk;
      })();
      return { status, headers, data };
    },
  };
}

test('audio policy accepts only HTTPS allowlisted URLs with supported extensions', () => {
  assert.equal(assertAllowedAudioUrl('https://cdn.jsdelivr.net/sfx/track.mp3'), true);
  assert.equal(isAllowedAudioContentType('audio/mpeg; charset=binary'), true);
  assert.equal(detectAudioExtension('https://assets.example.com/a/b/track.M4A'), '.m4a');

  assert.throws(() => assertAllowedAudioUrl('http://cdn.jsdelivr.net/track.mp3'), /HTTPS/);
  assert.throws(() => assertAllowedAudioUrl('https://evil.example.com/track.mp3'), /allowlist/);
  assert.throws(() => assertAllowedAudioUrl('https://cdn.jsdelivr.net/track.exe'), /ekstensi/i);
  assert.throws(() => assertAllowedAudioUrl('not-a-url'), /URL/);
});

test('audio magic bytes must match the declared extension', () => {
  assert.equal(matchesAudioMagicBytes(MP3_BYTES, '.mp3'), true);
  assert.equal(matchesAudioMagicBytes(WAV_BYTES, '.wav'), true);
  assert.equal(matchesAudioMagicBytes(M4A_BYTES, '.m4a'), true);
  assert.equal(matchesAudioMagicBytes(AAC_BYTES, '.aac'), true);
  assert.equal(matchesAudioMagicBytes(AAC_BYTES, '.mp3'), false);

  assert.equal(matchesAudioMagicBytes(Buffer.from('<!DOCTYPE html>'), '.mp3'), false);
  assert.equal(matchesAudioMagicBytes(Buffer.from('MZ\x90\x00'), '.wav'), false);
  assert.equal(matchesAudioMagicBytes(Buffer.alloc(2), '.m4a'), false);
});

test('audio byte guard rejects oversized Content-Length and stops runaway streams', () => {
  assert.throws(
    () => createAudioByteGuard({ contentLength: String(AUDIO_LIMITS.maxBytes + 1) }),
    /melebihi batas/
  );

  const guard = createAudioByteGuard({ contentLength: String(AUDIO_LIMITS.maxBytes) });
  assert.equal(guard.add(Buffer.alloc(AUDIO_LIMITS.maxBytes)), AUDIO_LIMITS.maxBytes);
  assert.throws(() => guard.add(Buffer.alloc(1)), /melebihi batas/);
});

test('audio download validates scheme, host, type, and size before writing', async () => {
  const transport = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'audio/mpeg', 'content-length': String(MP3_BYTES.length) },
  });

  const downloaded = await downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', { transport });
  assert.equal(downloaded.extension, '.mp3');
  assert.equal(downloaded.bytes.length, MP3_BYTES.length);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].options.timeout, AUDIO_LIMITS.downloadTimeoutMs);
  assert.equal(transport.calls[0].options.maxContentLength, AUDIO_LIMITS.maxBytes);
  assert.equal(transport.calls[0].options.maxBodyLength, AUDIO_LIMITS.maxBytes);

  await assert.rejects(
    downloadAudioAsset('http://cdn.jsdelivr.net/track.mp3', { transport }),
    /HTTPS/
  );
  await assert.rejects(
    downloadAudioAsset('https://evil.example.com/track.mp3', { transport }),
    /allowlist/
  );

  const wrongType = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'text/html' },
  });
  await assert.rejects(
    downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', { transport: wrongType }),
    /Content-Type/
  );

  const wrongBytes = createStreamTransport({
    chunks: [Buffer.from('MZ\x90\x00')],
    headers: { 'content-type': 'audio/mpeg' },
  });
  await assert.rejects(
    downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', { transport: wrongBytes }),
    /magic bytes/i
  );

  const oversized = createStreamTransport({
    chunks: [Buffer.alloc(2048)],
    headers: { 'content-type': 'audio/mpeg' },
  });
  await assert.rejects(
    downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', { transport: oversized }),
    /melebihi batas/
  );

  const failed = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'audio/mpeg' },
    status: 404,
  });
  await assert.rejects(
    downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', { transport: failed }),
    /HTTP 404/
  );
});

test('audio download re-validates every redirect hop against the allowlist', async () => {
  const allowedHop = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'audio/mpeg' },
    redirects: [{ headers: { location: 'https://assets.example.com/final.mp3' } }],
  });
  const followed = await downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', {
    transport: allowedHop,
  });
  assert.equal(followed.extension, '.mp3');

  const relativeHop = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'audio/mpeg' },
    redirects: [{ headers: { location: '/relative/final.mp3' } }],
  });
  const relative = await downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', {
    transport: relativeHop,
  });
  assert.equal(relative.extension, '.mp3');

  const crossHost = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'audio/mpeg' },
    redirects: [
      { headers: { location: 'https://assets.example.com/final.mp3' } },
      { headers: { location: 'https://evil.example.com/stolen.mp3' } },
    ],
  });
  await assert.rejects(
    downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', { transport: crossHost }),
    /allowlist/
  );

  const downgrade = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'audio/mpeg' },
    redirects: [{ headers: { location: 'http://cdn.jsdelivr.net/plain.mp3' } }],
  });
  await assert.rejects(
    downloadAudioAsset('https://cdn.jsdelivr.net/track.mp3', { transport: downgrade }),
    /HTTPS/
  );
});

test('FFmpeg argument builder only adds audio inputs when a local path exists', () => {
  const withoutAudio = buildAudioInputArgs(null);
  assert.deepEqual(withoutAudio, []);

  // -map pins video to the frame input so an M4A carrying a video track cannot
  // hijack the video stream of the render.
  const withAudio = buildAudioInputArgs('C:\\tmp\\track.mp3');
  assert.deepEqual(withAudio, [
    '-i', 'C:\\tmp\\track.mp3',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
  ]);
});

test('CLI --audio paths must stay inside allowed roots and match their extension', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-audio-cli-'));
  const inside = path.join(sandbox, 'track.mp3');
  await fs.writeFile(inside, MP3_BYTES);

  const resolved = await validateLocalAudioPath(inside, { allowedDirectories: [sandbox] });
  assert.equal(resolved, path.resolve(inside));

  await assert.rejects(
    validateLocalAudioPath(path.join(sandbox, '..', 'escape.mp3'), { allowedDirectories: [sandbox] }),
    /di luar direktori/
  );

  const wrongExtension = path.join(sandbox, 'track.exe');
  await fs.writeFile(wrongExtension, Buffer.from('MZ\x90\x00'));
  await assert.rejects(
    validateLocalAudioPath(wrongExtension, { allowedDirectories: [sandbox] }),
    /Ekstensi audio/
  );

  const wrongBytes = path.join(sandbox, 'fake.mp3');
  await fs.writeFile(wrongBytes, Buffer.from('MZ\x90\x00'));
  await assert.rejects(
    validateLocalAudioPath(wrongBytes, { allowedDirectories: [sandbox] }),
    /magic bytes/i
  );

  await assert.rejects(
    validateLocalAudioPath(path.join(sandbox, 'missing.mp3'), { allowedDirectories: [sandbox] }),
    /tidak ditemukan/
  );

  await fs.rm(sandbox, { recursive: true, force: true });
});

test('prepareAudioAsset caches the validated file and reuses it', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-audio-cache-'));
  process.chdir(dataDir);

  const { prepareAudioAsset } = await import('../vps-server/storage.js');
  const transport = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'audio/mpeg' },
  });
  // The fixture is a header-shaped stub, not real audio, so decode is stubbed out.
  const probeCalls = [];
  const probeAudio = async (filePath) => {
    probeCalls.push(filePath);
    return 1;
  };

  const first = await prepareAudioAsset('https://cdn.jsdelivr.net/track.mp3', {
    transport,
    probeAudio,
  });
  assert.equal(first.cached, false);
  assert.equal(probeCalls.length, 1);
  const stat = await fs.stat(first.localPath);
  assert.equal(stat.size, MP3_BYTES.length);

  const second = await prepareAudioAsset('https://cdn.jsdelivr.net/track.mp3', {
    transport: { get: async () => { throw new Error('cache must prevent a second download'); } },
    probeAudio,
  });
  assert.equal(second.cached, true);
  assert.equal(probeCalls.length, 1, 'a cache hit must not re-decode');

  await assert.rejects(
    prepareAudioAsset('https://evil.example.com/track.mp3', { transport, probeAudio }),
    /allowlist/
  );

  process.chdir(ORIGINAL_CWD);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('prepareAudioAsset discards the temporary file when decode fails', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-audio-corrupt-'));
  process.chdir(dataDir);

  const { prepareAudioAsset } = await import('../vps-server/storage.js');
  const transport = createStreamTransport({
    chunks: [MP3_BYTES],
    headers: { 'content-type': 'audio/mpeg' },
  });

  await assert.rejects(
    prepareAudioAsset('https://cdn.jsdelivr.net/broken.mp3', {
      transport,
      probeAudio: async () => {
        throw new Error('File audio tidak dapat didekode');
      },
    }),
    /tidak dapat didekode/
  );

  const { readdir } = fs;
  const entries = await readdir(path.join(dataDir, 'cache', 'assets')).catch(() => []);
  assert.deepEqual(entries, [], 'no partial or temporary audio file may survive');

  process.chdir(ORIGINAL_CWD);
  await fs.rm(dataDir, { recursive: true, force: true });
});
