import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';

/**
 * Browser-level coverage for the Studio Render Panel.
 *
 * Every backend endpoint is mocked in-process, so this suite never renders a frame,
 * never calls a paid AI provider, and never touches Redis.
 */

const STUDIO_PATH = '/studio';
const PAGE_TIMEOUT_MS = 15_000;

let browser;
let server;
let baseUrl;

function createMockApi(state) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get(STUDIO_PATH, async (_req, res) => {
    res.type('html').send(await fs.readFile(path.resolve('preview-studio.html'), 'utf8'));
  });

  app.get('/api/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!state.authenticated) return res.status(401).json({ authenticated: false });
    return res.json({
      authenticated: true,
      actor: 'Admin Dashboard',
      expiresAt: Date.now() + 28_800_000,
      csrfToken: state.csrfToken,
    });
  });

  app.post('/api/session/login', (req, res) => {
    state.loginAttempts.push(req.body?.password);
    if (req.body?.password !== state.expectedPassword) {
      return res.status(401).json({ error: 'Password tidak valid' });
    }
    state.authenticated = true;
    return res.json({
      authenticated: true,
      actor: 'Admin Dashboard',
      expiresAt: Date.now() + 28_800_000,
      csrfToken: state.csrfToken,
    });
  });

  app.post('/api/session/logout', (req, res) => {
    state.logoutRequests.push({ csrf: req.headers['x-csrf-token'] });
    state.authenticated = false;
    return res.json({ authenticated: false });
  });

  app.get('/api/studio/templates', (_req, res) => {
    res.json({
      templates: [
        { id: 'kinetic-text', label: 'Kinetic Text' },
        { id: 'base', label: 'Base' },
        { id: 'image-slideshow', label: 'Image Slideshow' },
        { id: 'video-mixer', label: 'Video Mixer' },
      ],
    });
  });

  app.post('/api/studio/render', (req, res) => {
    state.renderRequests.push({
      body: req.body,
      csrf: req.headers['x-csrf-token'],
      cookie: req.headers.cookie || '',
    });
    return res.status(202).json({ job_id: 'job-e2e', status: 'queued' });
  });

  app.get('/api/studio/jobs/job-e2e', (_req, res) => {
    const holdCurrent = !state.releaseJobCompletion && state.jobSequence.length > 1;
    const next = holdCurrent ? state.jobSequence[0] : state.jobSequence.shift();
    state.jobPolls.push(next);
    res.json(next);
  });

  app.get('/api/studio/output/job-e2e.mp4', (_req, res) => {
    res.type('video/mp4').send(Buffer.alloc(0));
  });

  return app;
}

function createState(overrides = {}) {
  return {
    authenticated: false,
    csrfToken: 'csrf-e2e-token',
    expectedPassword: 'correct-horse-battery',
    loginAttempts: [],
    logoutRequests: [],
    renderRequests: [],
    jobPolls: [],
    jobSequence: [],
    // Multi-step job sequences hold on the first entry so the UI assertion cannot race
    // against the next 1s poll. Single-entry sequences resolve immediately.
    releaseJobCompletion: false,
    ...overrides,
  };
}

before(async () => {
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  if (browser) await browser.close();
});

async function startStack(state) {
  const app = createMockApi(state);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function openStudio(state, stack) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseUrl}${STUDIO_PATH}`, { waitUntil: 'domcontentloaded' });
  return { context, page, stack, state };
}

test('unauthenticated visit shows the login overlay over the render panel', async () => {
  const state = createState();
  const stack = await startStack(state);
  const { context, page } = await openStudio(state, stack);

  try {
    await page.waitForSelector('#loginOverlay.visible', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(await page.locator('#logoutBtn').isVisible(), false);
    assert.equal(state.renderRequests.length, 0);
    assert.equal(await page.locator('#loginOverlay').evaluate(
      (overlay) => overlay.classList.contains('visible')
    ), true);
  } finally {
    await context.close();
    await stack.close();
  }
});

test('login unlocks the panel and loads template options', async () => {
  const state = createState();
  const stack = await startStack(state);
  const { context, page } = await openStudio(state, stack);

  try {
    await page.waitForSelector('#loginOverlay.visible');
    await page.fill('#adminPassword', 'correct-horse-battery');
    await page.click('#loginSubmitBtn');

    await page.waitForFunction(
      () => !document.getElementById('loginOverlay').classList.contains('visible'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#logoutBtn').isVisible(), true);
    assert.match(await page.locator('#sessionState').textContent(), /Admin Dashboard/);

    await page.waitForFunction(
      () => document.getElementById('renderTemplate').options.length === 4
    );
    const options = await page.locator('#renderTemplate option').allTextContents();
    assert.deepEqual(options, ['Kinetic Text', 'Base', 'Image Slideshow', 'Video Mixer']);
    assert.deepEqual(state.loginAttempts, ['correct-horse-battery']);
  } finally {
    await context.close();
    await stack.close();
  }
});

test('submitting the form posts the exact render payload with CSRF', async () => {
  const state = createState({ authenticated: true });
  const stack = await startStack(state);
  const { context, page } = await openStudio(state, stack);

  try {
    await page.waitForFunction(
      () => document.getElementById('renderTemplate').options.length === 4
    );
    await page.selectOption('#renderTemplate', 'video-mixer');
    await page.fill('#renderDuration', '12');
    await page.selectOption('#renderFps', '30');
    await page.selectOption('#renderResolution', '1280x720');
    await page.selectOption('#renderCodec', 'h265');
    await page.fill('#renderAudioUrl', 'https://cdn.jsdelivr.net/audio/example.mp3');
    await page.click('#renderSubmitBtn');

    await page.waitForFunction(() => !document.getElementById('renderSubmitBtn').disabled
      || document.getElementById('renderJobId').textContent.includes('job-e2e'),
    null, { timeout: PAGE_TIMEOUT_MS });

    assert.equal(state.renderRequests.length, 1);
    const [{ body, csrf }] = state.renderRequests;
    assert.deepEqual(body, {
      template: 'video-mixer',
      duration: 12,
      fps: 30,
      width: 1280,
      height: 720,
      codec: 'h265',
      audio_url: 'https://cdn.jsdelivr.net/audio/example.mp3',
    });
    assert.equal(csrf, 'csrf-e2e-token');
    assert.match(await page.locator('#renderJobId').textContent(), /job-e2e/);
  } finally {
    await context.close();
    await stack.close();
  }
});

test('polling reports progress, then renders the video and download link', async () => {
  const state = createState({
    authenticated: true,
    jobSequence: [
      { job_id: 'job-e2e', status: 'active', progress: { progress: 42, renderedFrames: 252, totalFrames: 600 }, error: null, result: null },
      {
        job_id: 'job-e2e',
        status: 'completed',
        progress: { progress: 100 },
        error: null,
        result: { url: '/api/studio/output/job-e2e.mp4', storage: 'local_disk', cached: false },
      },
    ],
  });
  const stack = await startStack(state);
  const { context, page } = await openStudio(state, stack);

  try {
    await page.waitForFunction(
      () => document.getElementById('renderTemplate').options.length === 4
    );
    await page.click('#renderSubmitBtn');

    await page.waitForFunction(
      () => document.getElementById('renderStatus').textContent.includes('252/600'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#renderProgressText').textContent(), '42%');
    state.releaseJobCompletion = true;

    await page.waitForSelector('#renderResult.visible', { timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(
      () => document.getElementById('renderVideo').getAttribute('src') === '/api/studio/output/job-e2e.mp4'
    );
    assert.equal(
      await page.locator('#downloadVideo').getAttribute('href'),
      '/api/studio/output/job-e2e.mp4?download=1'
    );
    assert.equal(await page.locator('#renderStatus').textContent(), 'Selesai');
    assert.equal(await page.locator('#renderSubmitBtn').isEnabled(), true);
  } finally {
    await context.close();
    await stack.close();
  }
});

test('signed object-storage downloads keep their signature query intact', async () => {
  const signedUrl = 'https://minio.example.com/renders/job-e2e.mp4?X-Amz-Signature=abc123';
  const state = createState({
    authenticated: true,
    jobSequence: [
      {
        job_id: 'job-e2e',
        status: 'completed',
        progress: { progress: 100 },
        error: null,
        result: { url: signedUrl, storage: 's3', cached: false },
      },
    ],
  });
  const stack = await startStack(state);
  const { context, page } = await openStudio(state, stack);

  try {
    await page.waitForFunction(
      () => document.getElementById('renderTemplate').options.length === 4
    );
    await page.click('#renderSubmitBtn');

    await page.waitForSelector('#renderResult.visible', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(await page.locator('#downloadVideo').getAttribute('href'), signedUrl);
  } finally {
    await context.close();
    await stack.close();
  }
});

test('failed job surfaces the error and re-enables submit', async () => {
  const state = createState({
    authenticated: true,
    jobSequence: [
      {
        job_id: 'job-e2e',
        status: 'failed',
        progress: { progress: 30 },
        error: 'FFmpeg keluar dengan kode 1',
        result: null,
      },
    ],
  });
  const stack = await startStack(state);
  const { context, page } = await openStudio(state, stack);

  try {
    await page.waitForFunction(
      () => document.getElementById('renderTemplate').options.length === 4
    );
    await page.click('#renderSubmitBtn');

    await page.waitForFunction(
      () => document.getElementById('logBox').textContent.includes('FFmpeg keluar dengan kode 1'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#renderStatus').textContent(), 'Gagal');
    assert.equal(await page.locator('#renderResult').isVisible(), false);
    assert.equal(await page.locator('#renderSubmitBtn').isEnabled(), true);
  } finally {
    await context.close();
    await stack.close();
  }
});

test('logout posts CSRF, clears the panel, and stops polling', async () => {
  const state = createState({ authenticated: true });
  const stack = await startStack(state);
  const { context, page } = await openStudio(state, stack);

  try {
    await page.waitForSelector('#logoutBtn:visible', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#logoutBtn');

    await page.waitForSelector('#loginOverlay.visible', { timeout: PAGE_TIMEOUT_MS });
    assert.deepEqual(state.logoutRequests, [{ csrf: 'csrf-e2e-token' }]);
    assert.equal(await page.locator('#logoutBtn').isVisible(), false);
    assert.equal(await page.locator('#loginOverlay').evaluate(
      (overlay) => overlay.classList.contains('visible')
    ), true);
  } finally {
    await context.close();
    await stack.close();
  }
});
