import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAudioForJob } from '../vps-server/renderer.js';

async function writeMp3(directory, name = 'track.mp3') {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, Buffer.from('ID3valid-audio-fixture'));
  return filePath;
}

test('resolveAudioForJob validates and uses builder local audio', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-render-audio-'));
  try {
    const audioLocalPath = await writeMp3(directory);
    let remoteCalls = 0;
    const resolved = await resolveAudioForJob(
      { audioLocalPath, audio_url: 'https://example.invalid/ignored.mp3' },
      {
        allowedDirectories: [directory],
        prepareRemoteAudio: async () => {
          remoteCalls += 1;
          return { localPath: 'remote.mp3' };
        },
      }
    );

    assert.deepEqual(resolved, { localPath: audioLocalPath });
    assert.equal(remoteCalls, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('resolveAudioForJob rejects builder audio outside trusted upload roots', async () => {
  const allowedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-audio-allowed-'));
  const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-audio-outside-'));
  try {
    const audioLocalPath = await writeMp3(outsideDirectory);
    await assert.rejects(
      () => resolveAudioForJob(
        { audioLocalPath },
        { allowedDirectories: [allowedDirectory] }
      ),
      /luar direktori/i
    );
  } finally {
    await Promise.all([
      fs.rm(allowedDirectory, { recursive: true, force: true }),
      fs.rm(outsideDirectory, { recursive: true, force: true }),
    ]);
  }
});

test('resolveAudioForJob preserves legacy remote audio behavior', async () => {
  const prepared = { localPath: '/cache/remote.mp3' };
  const result = await resolveAudioForJob(
    { audio_url: 'https://cdn.example/track.mp3' },
    { prepareRemoteAudio: async () => prepared }
  );
  assert.equal(result, prepared);
  assert.equal(await resolveAudioForJob({}), null);
});
