import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import express from 'express';
import {
  createStudioRouter,
  projectStudioJob,
} from '../vps-server/studio-routes.js';
import { validateJobLimits } from '../vps-server/middleware/limits.js';

function createStudioAuth(req, res, next) {
  if (req.headers.cookie !== 'motion_admin_session=valid') {
    return res.status(401).json({ error: 'Sesi admin tidak valid atau sudah berakhir' });
  }
  req.adminActor = 'Studio Admin';
  req.adminSession = { csrfToken: 'csrf-test-token' };
  next();
}

function requireCsrf(req, res, next) {
  if (req.headers['x-csrf-token'] !== req.adminSession.csrfToken) {
    return res.status(403).json({ error: 'Token CSRF tidak valid' });
  }
  next();
}

async function startStudioServer(options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/studio', createStudioRouter({
    authenticate: createStudioAuth,
    requireCsrf,
    ...options,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

function request(baseUrl, route, options = {}) {
  return fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      Cookie: 'motion_admin_session=valid',
      ...(options.headers || {}),
    },
  });
}

test('studio render requires session and CSRF without browser HMAC', async (context) => {
  const queuedPayloads = [];
  const { server, baseUrl } = await startStudioServer({
    enqueueJob: async (payload) => {
      queuedPayloads.push(payload);
      return { job_id: 'job-test', status: 'queued' };
    },
    readTemplate: async () => '<main>template</main>',
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const body = JSON.stringify({
    template: 'kinetic-text',
    duration: 12,
    fps: 30,
    width: 1280,
    height: 720,
    codec: 'h264',
    audio_url: 'https://cdn.jsdelivr.net/audio/example.mp3',
  });
  const unauthenticated = await fetch(`${baseUrl}/api/studio/render`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(unauthenticated.status, 401);

  const missingCsrf = await request(baseUrl, '/api/studio/render', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(missingCsrf.status, 403);

  const response = await request(baseUrl, '/api/studio/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test-token' },
    body,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { job_id: 'job-test', status: 'queued' });
  assert.equal(queuedPayloads.length, 1);
  assert.deepEqual(
    {
      template: queuedPayloads[0].template,
      duration: queuedPayloads[0].duration,
      fps: queuedPayloads[0].fps,
      width: queuedPayloads[0].width,
      height: queuedPayloads[0].height,
      codec: queuedPayloads[0].codec,
      audio_url: queuedPayloads[0].audio_url,
      submittedBy: queuedPayloads[0].submittedBy,
    },
    {
      template: 'kinetic-text',
      duration: 12,
      fps: 30,
      width: 1280,
      height: 720,
      codec: 'h264',
      audio_url: 'https://cdn.jsdelivr.net/audio/example.mp3',
      submittedBy: 'Studio Admin',
    }
  );
});

test('render boundary rejects invalid numeric, codec, and audio values', () => {
  assert.throws(() => validateJobLimits({ duration: Number.NaN }), /Duration/);
  assert.throws(() => validateJobLimits({ fps: 29.5 }), /FPS/);
  assert.throws(() => validateJobLimits({ width: 0 }), /Resolution/);
  assert.throws(() => validateJobLimits({ height: Number.POSITIVE_INFINITY }), /Resolution/);
  assert.throws(() => validateJobLimits({ codec: 'vp9' }), /Codec/);
  assert.throws(() => validateJobLimits({ audio_url: 42 }), /URL audio/);
  assert.throws(
    () => validateJobLimits({ audio_url: 'http://cdn.jsdelivr.net/audio/example.mp3' }),
    /HTTPS/
  );
});

test('studio job projection removes internal payload and rewrites local output URL', () => {
  const projected = projectStudioJob({
    job_id: 'job-test',
    status: 'completed',
    progress: { percent: 100, renderedFrames: 300 },
    payload: { html: '<script>secret</script>' },
    result: {
      url: 'https://studio.example.com/output/job-test.mp4',
      localPath: '/srv/output/job-test.mp4',
      storage: 'local_disk',
      cached: false,
      render_time_seconds: 4.2,
    },
    internalField: 'secret',
  });

  assert.deepEqual(projected, {
    job_id: 'job-test',
    status: 'completed',
    progress: { percent: 100, renderedFrames: 300 },
    error: null,
    result: {
      url: '/api/studio/output/job-test.mp4',
      storage: 'local_disk',
      cached: false,
      render_time_seconds: 4.2,
    },
  });
  assert.equal(JSON.stringify(projected).includes('secret'), false);
});

test('studio job projection strips internals carried inside the BullMQ progress object', () => {
  const projected = projectStudioJob({
    job_id: 'job-bull',
    status: 'completed',
    // BullMQ stores the renderer's final `onProgress(finalResult)` call verbatim.
    progress: {
      job_id: 'job-bull',
      status: 'completed',
      progress: 100,
      url: 'https://minio.example.com/renders/job-bull.mp4?X-Amz-Signature=abc123',
      storage: 's3',
      hash: 'deadbeef',
      deepseek_engineer: { stages: [{ prompt: 'internal' }] },
    },
    result: { url: 'https://minio.example.com/renders/job-bull.mp4?X-Amz-Signature=abc123', storage: 's3' },
  });

  // `result.url` legitimately carries the signed URL the browser needs to play the video.
  // Progress must never carry it, nor any internal hash or engineer report.
  assert.deepEqual(projected.progress, { status: 'completed', progress: 100 });
  const serialized = JSON.stringify(projected);
  assert.equal(JSON.stringify(projected.progress).includes('X-Amz-Signature'), false);
  assert.equal(serialized.includes('deadbeef'), false);
  assert.equal(serialized.includes('deepseek_engineer'), false);
});

test('studio job projection keeps frame telemetry from the in-memory queue', () => {
  const projected = projectStudioJob({
    job_id: 'job-memory',
    status: 'processing',
    progress: 42,
    renderedFrames: 170,
    totalFrames: 600,
    result: null,
  });

  assert.deepEqual(projected, {
    job_id: 'job-memory',
    status: 'processing',
    progress: { progress: 42, renderedFrames: 170, totalFrames: 600 },
    error: null,
    result: null,
  });
});

test('studio templates expose shipped HTML identifiers only', async (context) => {
  const { server, baseUrl } = await startStudioServer({
    listTemplateFiles: async () => ['base.html', 'notes.txt', '../escape.html', 'video-mixer.html'],
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(baseUrl, '/api/studio/templates');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    templates: [
      { id: 'base', label: 'Base' },
      { id: 'video-mixer', label: 'Video Mixer' },
    ],
  });
});

test('studio render does not leak filesystem paths when a template is missing', async (context) => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/app/render-engine/templates/ghost.html'"), {
    code: 'ENOENT',
  });
  const { server, baseUrl } = await startStudioServer({
    readTemplate: async () => { throw missing; },
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(baseUrl, '/api/studio/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test-token' },
    body: JSON.stringify({ template: 'ghost', duration: 5, fps: 30, width: 1280, height: 720, codec: 'h264' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(body, { error: 'Template tidak tersedia' });
  assert.equal(JSON.stringify(body).includes('/app/'), false);
});

test('studio output validates filename and supports preview and download', async (context) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-studio-output-'));
  context.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(outputDir, 'job-test.mp4'), Buffer.from('video'));
  const { server, baseUrl } = await startStudioServer({ outputDir });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const traversal = await request(baseUrl, '/api/studio/output/%2e%2e%2fsecret.mp4');
  assert.equal(traversal.status, 400);
  const invalidExtension = await request(baseUrl, '/api/studio/output/job-test.exe');
  assert.equal(invalidExtension.status, 400);

  const preview = await request(baseUrl, '/api/studio/output/job-test.mp4');
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-disposition'), null);

  const download = await request(baseUrl, '/api/studio/output/job-test.mp4?download=1');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment; filename="job-test.mp4"/);
});
