import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJob } from '../vps-server/cache.js';

const BASE_JOB = {
  html: '<!DOCTYPE html><p>x</p>',
  fps: 30,
  duration: 10,
  width: 1280,
  height: 720,
  codec: 'h264',
};

test('hashJob is deterministic and includes every render input', () => {
  assert.equal(hashJob(BASE_JOB), hashJob({ ...BASE_JOB }));
  assert.notEqual(
    hashJob(BASE_JOB),
    hashJob({ ...BASE_JOB, duration: 11 })
  );
  assert.notEqual(
    hashJob(BASE_JOB),
    hashJob({ ...BASE_JOB, codec: 'h265' })
  );
});

test('hashJob separates local audio path from remote audio url', () => {
  const localA = hashJob({ ...BASE_JOB, audioLocalPath: '/uploads/a.mp3' });
  const localB = hashJob({ ...BASE_JOB, audioLocalPath: '/uploads/b.mp3' });
  const remote = hashJob({ ...BASE_JOB, audio_url: 'https://cdn.example/a.mp3' });
  const none = hashJob(BASE_JOB);

  assert.notEqual(localA, localB);
  assert.notEqual(localA, remote);
  assert.notEqual(localA, none);
});
