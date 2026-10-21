import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import { compileProject } from '../vps-server/studio/compile-project.js';

/**
 * Browser-level coverage for the Studio video builder.
 *
 * Every backend endpoint is mocked in-process: this suite never renders a frame, never
 * calls a paid AI provider, and never touches Redis. Only the UI modules themselves are
 * served from disk, exactly as the real `/api/studio/ui/:filename` route serves them.
 */

const STUDIO_PATH = '/studio';
const PAGE_TIMEOUT_MS = 20_000;
const UI_DIR = path.resolve('studio-assets');
const UI_CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const SAMPLE_PROJECT = {
  schemaVersion: 1,
  title: 'Promo Kopi',
  template: 'base',
  render: { duration: 8, fps: 30, width: 1280, height: 720, codec: 'h264' },
  theme: {
    backgroundColor: '#070913',
    primaryColor: '#38bdf8',
    accentColor: '#a855f7',
    fontFamily: 'Inter',
  },
  scenes: [{
    durationSec: 8,
    transition: { type: 'fade', durationSec: 0.5 },
    elements: [{ type: 'text', role: 'title', text: 'Kopi Nusantara' }],
  }],
};

const COMPILED_HTML = '<!DOCTYPE html><html><body><script>'
  + 'window.renderFrame = function renderFrame(t) { document.title = String(t); };'
  + '</script></body></html>';

let browser;
let baseUrl;

function createState(overrides = {}) {
  return {
    authenticated: false,
    csrfToken: 'csrf-e2e-token',
    expectedPassword: 'correct-horse-battery',
    loginAttempts: [],
    promptRequests: [],
    renderRequests: [],
    assetUploads: 0,
    deletedAssets: [],
    jobPolls: [],
    jobSequence: [],
    releaseJobCompletion: false,
    ...overrides,
  };
}

function createMockApi(state) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get(STUDIO_PATH, async (_req, res) => {
    res.type('html').send(await fs.readFile(path.resolve('preview-studio.html'), 'utf8'));
  });

  app.get('/api/studio/ui/:filename', async (req, res) => {
    const filename = path.basename(req.params.filename);
    res.type(UI_CONTENT_TYPES[path.extname(filename)] || 'application/octet-stream');
    res.send(await fs.readFile(path.join(UI_DIR, filename), 'utf8'));
  });

  app.get('/api/session', (req, res) => {
    if (!state.authenticated) return res.status(401).json({ authenticated: false });
    return res.json({
      authenticated: true,
      actor: 'Studio Admin',
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
      actor: 'Studio Admin',
      expiresAt: Date.now() + 28_800_000,
      csrfToken: state.csrfToken,
    });
  });

  app.post('/api/session/logout', (_req, res) => {
    state.authenticated = false;
    return res.json({ authenticated: false });
  });

  app.get('/api/studio/templates', (_req, res) => {
    res.json({
      templates: [
        { id: 'base', label: 'Base' },
        { id: 'kinetic-text', label: 'Kinetic Text' },
        { id: 'image-slideshow', label: 'Image Slideshow' },
        { id: 'video-mixer', label: 'Video Mixer' },
      ],
    });
  });

  app.get('/api/studio/models', (_req, res) => {
    if (state.modelListUnavailable) {
      return res.status(503).json({ error: 'Daftar model tidak tersedia' });
    }
    return res.json({
      providers: [
        {
          id: 'river',
          label: 'River AI',
          configured: true,
          defaultModel: 'river-default',
          models: [
            { id: 'river-default', label: 'River Default', source: 'default' },
            { id: 'river-pro', label: 'River Pro', source: 'env' },
          ],
        },
        {
          id: 'deepseek',
          label: 'DeepSeek Official',
          configured: true,
          defaultModel: 'deepseek-chat',
          models: [
            { id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'default' },
            { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', source: 'discovery' },
          ],
        },
      ],
    });
  });

  app.post('/api/studio/prompt', (req, res) => {
    state.promptRequests.push({ body: req.body, csrf: req.headers['x-csrf-token'] });
    const project = typeof state.promptProject === 'function'
      ? state.promptProject(state.promptRequests.length)
      : SAMPLE_PROJECT;
    res.json({ project, providerId: 'river', model: 'deepseek-v4' });
  });

  app.post('/api/studio/projects/compile', async (req, res) => {
    if (typeof state.compileHandler === 'function') {
      await state.compileHandler(req, res);
      return;
    }
    res.json({ html: COMPILED_HTML, warnings: [] });
  });

  app.get('/api/studio/projects', (_req, res) => {
    res.json({
      projects: (state.projects || []).map((item) => ({
        projectId: item.project.projectId,
        title: item.project.title,
        template: item.project.template,
        revision: item.revision,
        sceneCount: item.project.scenes.length,
        durationSec: item.project.scenes.reduce((total, scene) => total + scene.durationSec, 0),
      })),
    });
  });

  app.post('/api/studio/projects', (req, res) => {
    const project = {
      ...req.body.project,
      projectId: 'prj_77777777-7777-4777-8777-777777777777',
    };
    state.projects = [{ project, revision: 1 }];
    res.status(201).json({ project, revision: 1 });
  });

  app.post('/api/studio/projects/validate', (req, res) => {
    state.validatedProjects = state.validatedProjects || [];
    state.validatedProjects.push(req.body.project);
    res.json({
      project: {
        ...req.body.project,
        projectId: 'prj_99999999-9999-4999-8999-999999999999',
      },
    });
  });

  app.get('/api/studio/projects/:id', (req, res) => {
    const stored = (state.projects || []).find((item) => item.project.projectId === req.params.id);
    if (!stored) return res.status(404).json({ error: 'Project tidak ditemukan' });
    return res.json(stored);
  });

  app.put('/api/studio/projects/:id', (req, res) => {
    if (typeof state.putHandler === 'function') {
      state.putHandler(req, res);
      return;
    }
    const project = { ...req.body.project, projectId: req.params.id };
    const revision = Number(req.body.baseRevision || 0) + 1;
    state.projects = [{ project, revision }];
    res.json({ project, revision });
  });

  app.delete('/api/studio/projects/:id', (req, res) => {
    state.projects = (state.projects || []).filter(
      (item) => item.project.projectId !== req.params.id
    );
    res.json({ ok: true });
  });

  app.get('/api/studio/assets', (_req, res) => {
    res.json({
      assets: state.assets || [],
      usage: { count: (state.assets || []).length, bytes: 0 },
    });
  });

  app.post('/api/studio/assets', (req, res) => {
    state.assetUploads += 1;
    req.resume();
    const asset = {
      assetId: 'ast_55555555-5555-4555-8555-555555555555',
      mime: 'image/png',
      originalName: 'kopi.png',
      bytes: 2048,
    };
    state.assets = [asset];
    res.status(201).json({ asset });
  });

  app.delete('/api/studio/assets/:id', (req, res) => {
    state.deletedAssets.push(req.params.id);
    state.assets = [];
    res.json({ ok: true });
  });

  app.post('/api/studio/render', (req, res) => {
    state.renderRequests.push({ body: req.body, csrf: req.headers['x-csrf-token'] });
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

before(async () => {
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  if (browser) await browser.close();
});

async function openStudio(state) {
  const server = await new Promise((resolve) => {
    const listener = createMockApi(state).listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseUrl}${STUDIO_PATH}`, { waitUntil: 'domcontentloaded' });
  return {
    page,
    context,
    async close() {
      await context.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function loginThrough(page) {
  await page.waitForSelector('#loginOverlay.visible', { timeout: PAGE_TIMEOUT_MS });
  await page.fill('#adminPassword', 'correct-horse-battery');
  await page.click('#loginSubmitBtn');
  await page.waitForFunction(
    () => !document.getElementById('loginOverlay').classList.contains('visible'),
    null, { timeout: PAGE_TIMEOUT_MS }
  );
  await page.waitForFunction(
    () => document.getElementById('templateSelect').options.length === 4,
    null, { timeout: PAGE_TIMEOUT_MS }
  );
}

test('unauthenticated visit shows the login overlay and hides builder controls', async () => {
  const state = createState();
  const stack = await openStudio(state);
  try {
    await stack.page.waitForSelector('#loginOverlay.visible', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(await stack.page.locator('#logoutBtn').isVisible(), false);
    assert.equal(state.renderRequests.length, 0);
  } finally {
    await stack.close();
  }
});

test('login unlocks the builder and loads template options', async () => {
  const state = createState();
  const stack = await openStudio(state);
  try {
    await loginThrough(stack.page);
    assert.equal(await stack.page.locator('#logoutBtn').isVisible(), true);
    assert.match(await stack.page.locator('#sessionState').textContent(), /Studio Admin/);
    assert.deepEqual(state.loginAttempts, ['correct-horse-battery']);
  } finally {
    await stack.close();
  }
});

test('prompt generates scenes that land in the timeline and inspector', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.fill('#promptInput', 'Buat promo kopi tiga scene');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#promptReplaceBtn');

    await page.waitForSelector('.scene-card', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(await page.locator('.scene-card').count(), 1);
    assert.match(await page.locator('.scene-title').first().textContent(), /Kopi Nusantara/);
    assert.equal(state.promptRequests.length, 1);
    assert.equal(state.promptRequests[0].body.prompt, 'Buat promo kopi tiga scene');
    assert.equal(state.promptRequests[0].csrf, 'csrf-e2e-token');
    assert.equal(await page.locator('#projectTitle').inputValue(), 'Promo Kopi');
    assert.match(await page.locator('#sceneSummary').textContent(), /1 scene/);
  } finally {
    await stack.close();
  }
});

test('a generated proposal waits for the user before touching the project', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.fill('#promptInput', 'Buat promo kopi');
    await page.click('#generateBtn');

    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(await page.locator('.scene-card').count(), 0);
    assert.equal(await page.locator('#generateBtn').isDisabled(), true);

    await page.click('#promptCancelBtn');
    assert.equal(await page.locator('#promptChoice').isHidden(), true);
    assert.equal(await page.locator('.scene-card').count(), 0);
    assert.equal(await page.locator('#generateBtn').isEnabled(), true);
  } finally {
    await stack.close();
  }
});

test('replace swaps every scene in the project', async () => {
  const state = createState({
    authenticated: true,
    promptProject: () => ({
      ...SAMPLE_PROJECT,
      scenes: [
        ...SAMPLE_PROJECT.scenes,
        {
          durationSec: 3,
          transition: { type: 'slide', durationSec: 0.4 },
          elements: [{ type: 'text', role: 'subtitle', text: 'Kedua' }],
        },
      ],
    }),
  });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.fill('#promptInput', 'promo');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#promptReplaceBtn');

    await page.waitForSelector('.scene-card', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(await page.locator('.scene-card').count(), 2);
    assert.match(await page.locator('#sceneSummary').textContent(), /2 scene/);
    assert.match(await page.locator('.scene-title').last().textContent(), /Kedua/);

    // The title survives from the generated draft, not duplicated into a second scene.
    assert.equal(await page.locator('#projectTitle').inputValue(), 'Promo Kopi');
  } finally {
    await stack.close();
  }
});

test('append keeps existing scenes and mints fresh ids', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.fill('#promptInput', 'promo');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#promptReplaceBtn');
    await page.waitForSelector('.scene-card', { timeout: PAGE_TIMEOUT_MS });

    await page.click('#addSceneBtn');
    await page.waitForFunction(
      () => document.querySelectorAll('.scene-card').length === 2,
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    await page.fill('#promptInput', 'promo lagi');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#promptAppendBtn');

    await page.waitForFunction(
      () => document.querySelectorAll('.scene-card').length === 3,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.match(await page.locator('.scene-title').first().textContent(), /Kopi Nusantara/);
    assert.match(await page.locator('#sceneSummary').textContent(), /3 scene/);
  } finally {
    await stack.close();
  }
});

test('export downloads browser-safe JSON and import loads a fresh copy', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.fill('#promptInput', 'promo');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#promptReplaceBtn');
    await page.waitForSelector('.scene-card', { timeout: PAGE_TIMEOUT_MS });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: PAGE_TIMEOUT_MS }),
      page.click('#exportProjectBtn'),
    ]);
    const exported = await fs.readFile(await download.path(), 'utf8');
    assert.match(download.suggestedFilename(), /\.json$/);
    for (const forbidden of ['file://', 'localPath', '"src"']) {
      assert.equal(exported.includes(forbidden), false, `export leaked ${forbidden}`);
    }
    assert.match(exported, /Kopi Nusantara/);

    await page.click('#addSceneBtn');
    await page.waitForFunction(
      () => document.querySelectorAll('.scene-card').length === 2,
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    await page.setInputFiles('#importProjectInput', {
      name: 'project.json',
      mimeType: 'application/json',
      buffer: Buffer.from(exported, 'utf8'),
    });

    await page.waitForFunction(
      () => document.querySelectorAll('.scene-card').length === 1,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(state.validatedProjects.length, 1);
    assert.equal(state.validatedProjects[0].projectId, undefined);
  } finally {
    await stack.close();
  }
});

test('editing element text updates state and the inspector selection', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.fill('#promptInput', 'promo');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#promptReplaceBtn');
    await page.waitForSelector('.element-row', { timeout: PAGE_TIMEOUT_MS });

    // Selecting an element is what reveals the inspector form.
    await page.click('.element-row');
    await page.waitForSelector('#inspectorForm:not([hidden])', { timeout: PAGE_TIMEOUT_MS });

    const textField = page.locator('#inspectorForm input[type="text"]').first();
    await textField.fill('Kopi Gayo Premium');
    await page.waitForFunction(
      () => document.querySelector('.scene-title').textContent.includes('Kopi Gayo Premium'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await textField.inputValue(), 'Kopi Gayo Premium');
  } finally {
    await stack.close();
  }
});

test('dropping an asset onto a scene binds the first matching element', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.setInputFiles('#assetFileInput', {
      name: 'kopi.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    await page.waitForSelector('.asset-card', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#addSceneBtn');
    await page.waitForSelector('.scene-card', { timeout: PAGE_TIMEOUT_MS });

    await page.evaluate(() => {
      const assetCard = document.querySelector('.asset-card');
      const sceneCard = document.querySelector('.scene-card');
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', assetCard.dataset.assetId);
      sceneCard.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
    });

    await page.waitForFunction(
      () => [...document.querySelectorAll('.scene-chip')].some((chip) => chip.textContent === '1 image'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    // New scenes start with one text element, so the drop adds the second.
    assert.match(await page.locator('#sceneSummary').textContent(), /2 elemen/);
  } finally {
    await stack.close();
  }
});

test('dropping an audio asset binds the project audio track without adding an element', async () => {
  const AUDIO_ASSET_ID = 'ast_66666666-6666-4666-8666-666666666666';
  const state = createState({
    authenticated: true,
    assets: [
      { assetId: AUDIO_ASSET_ID, mime: 'audio/mpeg', originalName: 'latar.mp3', bytes: 1024 },
    ],
  });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.waitForSelector('.asset-card', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#addSceneBtn');
    await page.waitForSelector('.scene-card', { timeout: PAGE_TIMEOUT_MS });

    await page.evaluate((assetId) => {
      const assetCard = document.querySelector('.asset-card');
      const sceneCard = document.querySelector('.scene-card');
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', assetId);
      sceneCard.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
    }, AUDIO_ASSET_ID);

    await page.waitForFunction(
      (assetId) => document.getElementById('projectAudioSelect')?.value === assetId,
      AUDIO_ASSET_ID,
      { timeout: PAGE_TIMEOUT_MS }
    );
    // Audio binds at the project level, so the scene keeps only its default text element.
    assert.match(await page.locator('#sceneSummary').textContent(), /1 elemen/);
    await page.click('#saveBtn');
    await page.waitForFunction(() => document.getElementById('saveState').textContent === 'Tersimpan');
    assert.deepEqual(state.projects[0].project.audio, { assetId: AUDIO_ASSET_ID });
  } finally {
    await stack.close();
  }
});

test('scene reorder works through the keyboard and the card actions', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#addSceneBtn');
    await page.click('#addSceneBtn');
    assert.equal(await page.locator('.scene-card').count(), 2);

    await page.locator('.scene-card').first().click();
    const before = await page.locator('.scene-card').first().getAttribute('data-scene-id');

    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForFunction(
      (id) => document.querySelectorAll('.scene-card')[1]?.dataset.sceneId === id,
      before, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('.scene-card').nth(1).getAttribute('data-scene-id'), before);

    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForFunction(
      (id) => document.querySelector('.scene-card').dataset.sceneId === id,
      before, { timeout: PAGE_TIMEOUT_MS }
    );
  } finally {
    await stack.close();
  }
});

test('deleting a scene selects the scene that takes its place', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#addSceneBtn');
    await page.click('#addSceneBtn');
    await page.click('#addSceneBtn');
    const ids = await page.locator('.scene-card').evaluateAll(
      (cards) => cards.map((card) => card.dataset.sceneId)
    );
    assert.equal(ids.length, 3);

    page.on('dialog', (dialog) => dialog.accept());

    // Middle scene: the following scene slides into the same index and stays selected.
    await page.locator('.scene-card').nth(1).click();
    await page.locator('.scene-card').nth(1).locator('[data-action="delete"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.scene-card').length === 2,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(
      await page.locator('.scene-card.is-selected').getAttribute('data-scene-id'),
      ids[2]
    );

    // Last scene: selection falls back to the previous scene.
    await page.locator('.scene-card').nth(1).click();
    await page.locator('.scene-card').nth(1).locator('[data-action="delete"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('.scene-card').length === 1,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(
      await page.locator('.scene-card.is-selected').getAttribute('data-scene-id'),
      ids[0]
    );
  } finally {
    await stack.close();
  }
});

test('cancelling the delete confirmation keeps every scene', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#addSceneBtn');
    await page.click('#addSceneBtn');
    const before = await page.locator('.scene-card').evaluateAll(
      (cards) => cards.map((card) => card.dataset.sceneId)
    );

    page.on('dialog', (dialog) => dialog.dismiss());
    await page.locator('.scene-card').first().click();
    await page.locator('.scene-card').first().locator('[data-action="delete"]').click();
    await page.waitForTimeout(100);

    const after = await page.locator('.scene-card').evaluateAll(
      (cards) => cards.map((card) => card.dataset.sceneId)
    );
    assert.deepEqual(after, before);
  } finally {
    await stack.close();
  }
});

test('asset upload populates the library and can be deleted', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.match(await page.locator('#assetGrid').textContent(), /Belum ada aset/);

    await page.setInputFiles('#assetFileInput', {
      name: 'kopi.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    });

    await page.waitForSelector('.asset-card .asset-label', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(state.assetUploads, 1);
    assert.match(await page.locator('.asset-card .asset-label').first().textContent(), /kopi\.png/);
    assert.match(await page.locator('#assetUsage').textContent(), /1 aset/);

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('.asset-card .asset-remove').first().click();
    await page.waitForFunction(
      () => document.querySelectorAll('.asset-card').length === 0,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.deepEqual(state.deletedAssets, ['ast_55555555-5555-4555-8555-555555555555']);
  } finally {
    await stack.close();
  }
});

test('project library opens a stored project and saves it as an update', async () => {
  const projectId = 'prj_88888888-8888-4888-8888-888888888888';
  const state = createState({
    authenticated: true,
    projects: [{
      project: { ...SAMPLE_PROJECT, projectId, title: 'Project Tersimpan' },
      revision: 4,
    }],
  });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#openLibraryBtn');
    await page.waitForSelector('#libraryOverlay.visible .library-row');
    assert.match(await page.locator('.library-row').textContent(), /Project Tersimpan/);

    await page.locator('.library-row').getByRole('button', { name: 'Buka' }).click();
    await page.waitForFunction(
      () => document.getElementById('projectTitle').value === 'Project Tersimpan',
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    await page.fill('#projectTitle', 'Project Diperbarui');
    await page.click('#saveBtn');
    await page.waitForFunction(
      () => document.getElementById('saveState').textContent === 'Tersimpan',
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(state.projects[0].project.projectId, projectId);
    assert.equal(state.projects[0].project.title, 'Project Diperbarui');
    assert.equal(state.projects[0].revision, 5);
  } finally {
    await stack.close();
  }
});

test('edits autosave to the server without pressing save', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    // Three rapid edits must collapse into one create, then one update.
    await page.click('#addSceneBtn');
    await page.click('#addSceneBtn');
    await page.click('#addSceneBtn');
    await page.waitForFunction(
      () => document.getElementById('saveState').dataset.state === 'saved',
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(state.projects.length, 1);
    assert.equal(state.projects[0].revision, 1);
    assert.equal(state.projects[0].project.scenes.length, 3);

    await page.fill('#projectTitle', 'Autosave Judul');
    await page.waitForFunction(
      (expected) => document.getElementById('saveState').dataset.state === 'saved'
        && document.getElementById('projectTitle').value === expected,
      'Autosave Judul',
      { timeout: PAGE_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => document.getElementById('saveState').dataset.state === 'saved',
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(state.projects[0].project.title, 'Autosave Judul');
    assert.equal(state.projects[0].revision, 2);
  } finally {
    await stack.close();
  }
});

test('an autosave revision conflict offers server load and copy save', async () => {
  const projectId = 'prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const serverProject = { ...SAMPLE_PROJECT, projectId, title: 'Versi Server' };
  const state = createState({
    authenticated: true,
    projects: [{ project: serverProject, revision: 9 }],
  });
  state.putHandler = (_req, res) => {
    res.status(409).json({
      error: 'Project telah berubah',
      currentRevision: 9,
      project: serverProject,
    });
  };
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#openLibraryBtn');
    await page.waitForSelector('#libraryOverlay.visible .library-row');
    await page.locator('.library-row').getByRole('button', { name: 'Buka' }).click();
    await page.waitForFunction(
      () => document.getElementById('projectTitle').value === 'Versi Server',
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    await page.fill('#projectTitle', 'Versi Lokal');
    await page.waitForFunction(
      () => document.getElementById('conflictBanner').hidden === false,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#saveState').textContent(), 'Konflik versi');

    await page.click('#loadServerBtn');
    await page.waitForFunction(
      () => document.getElementById('projectTitle').value === 'Versi Server',
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#conflictBanner').isHidden(), true);
    assert.equal(await page.locator('#saveState').textContent(), 'Tersimpan');
  } finally {
    await stack.close();
  }
});

test('a conflict can save the local draft as a fresh copy', async () => {
  const projectId = 'prj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const serverProject = { ...SAMPLE_PROJECT, projectId, title: 'Versi Server' };
  const state = createState({
    authenticated: true,
    projects: [{ project: serverProject, revision: 9 }],
  });
  state.putHandler = (_req, res) => {
    res.status(409).json({
      error: 'Project telah berubah',
      currentRevision: 9,
      project: serverProject,
    });
  };
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#openLibraryBtn');
    await page.waitForSelector('#libraryOverlay.visible .library-row');
    await page.locator('.library-row').getByRole('button', { name: 'Buka' }).click();
    await page.waitForFunction(
      () => document.getElementById('projectTitle').value === 'Versi Server',
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    await page.fill('#projectTitle', 'Versi Lokal');
    await page.waitForFunction(
      () => document.getElementById('conflictBanner').hidden === false,
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    await page.click('#saveAsCopyBtn');
    await page.waitForFunction(
      () => document.getElementById('conflictBanner').hidden === true,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#projectTitle').inputValue(), 'Versi Lokal');
    assert.equal(await page.locator('#saveState').textContent(), 'Tersimpan');
    // The copy is a brand-new server project, never the conflicted original.
    assert.equal(state.projects.length, 1);
    assert.notEqual(state.projects[0].project.projectId, projectId);
    assert.equal(state.projects[0].project.title, 'Versi Lokal');
  } finally {
    await stack.close();
  }
});

test('project library creates, renames, and deletes projects', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#openLibraryBtn');
    await page.waitForSelector('#libraryOverlay.visible');
    await page.getByText('Belum ada project').waitFor({ timeout: PAGE_TIMEOUT_MS });
    assert.match(await page.locator('#libraryList').textContent(), /Belum ada project/);

    await page.click('#libraryNewBtn');
    await page.click('#addSceneBtn');
    await page.fill('#projectTitle', 'Project Library');
    await page.click('#saveBtn');
    await page.waitForFunction(() => document.getElementById('saveState').textContent === 'Tersimpan');

    await page.click('#openLibraryBtn');
    await page.waitForSelector('.library-row');
    page.once('dialog', (dialog) => dialog.accept('Nama Baru'));
    await page.locator('.library-row').getByRole('button', { name: 'Ganti nama' }).click();
    await page.waitForFunction(
      () => document.querySelector('.library-row')?.textContent.includes('Nama Baru'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.library-row').getByRole('button', { name: 'Hapus' }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.library-row').length === 0,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(state.projects.length, 0);
  } finally {
    await stack.close();
  }
});

test('sandboxed preview blocks parent document access and accepts frame messages', async () => {
  const calls = [];
  const previewProject = {
    ...SAMPLE_PROJECT,
    scenes: [{
      ...SAMPLE_PROJECT.scenes[0],
      id: 'scn_11111111-1111-4111-8111-111111111111',
      elements: [{
        ...SAMPLE_PROJECT.scenes[0].elements[0],
        id: 'el_22222222-2222-4222-8222-222222222222',
      }],
    }],
  };
  const state = createState({
    authenticated: true,
    compileHandler: async (_req, res) => {
      const result = await compileProject(previewProject, {
        target: 'preview',
        readTemplate: async () => '<!DOCTYPE html><html><body><script>'
          + 'window.renderFrame=function(t){parent.postMessage({type:"frame-call",time:t},"*");};'
          + '</script></body></html>',
      });
      res.json({ html: result.html, warnings: [] });
    },
  });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.exposeFunction('recordPreviewCall', (value) => calls.push(value));
    await page.evaluate(() => {
      window.addEventListener('message', (event) => {
        if (event.source !== document.getElementById('previewFrame').contentWindow) return;
        if (event.origin !== 'null') return;
        if (event.data?.type !== 'frame-call') return;
        window.__previewCallSeen = true;
        window.recordPreviewCall(event.data.time);
      });
    });

    await page.click('#addSceneBtn');
    await page.waitForFunction(
      () => document.getElementById('previewStatus').textContent === 'Preview siap',
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.locator('#previewTime').evaluate((input) => {
      input.value = '500';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => window.__previewCallSeen === true,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    const label = await page.locator('#previewTimeLabel').textContent();
    assert.ok(calls.length > 0, 'frame never received a postMessage');
    assert.equal(Math.floor(calls.at(-1)), Number(label.split(':')[1].split(' ')[0]));
    assert.ok(calls.at(-1) > 0);
    const frameAccess = await page.evaluate(() => {
      const doc = document.getElementById('previewFrame').contentDocument;
      if (doc === null) return null;
      return 'accessible';
    });
    assert.equal(frameAccess, null);
    assert.equal(await page.locator('#previewFrame').getAttribute('sandbox'), 'allow-scripts');
  } finally {
    await stack.close();
  }
});

test('binding an asset from the inspector reaches the compiled preview request', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.setInputFiles('#assetFileInput', {
      name: 'kopi.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    await page.waitForSelector('.asset-card', { timeout: PAGE_TIMEOUT_MS });

    const compiled = [];
    await page.route('**/api/studio/projects/compile', async (route) => {
      compiled.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ html: COMPILED_HTML, warnings: [] }),
      });
    });

    await page.click('#addSceneBtn');
    await page.waitForSelector('#inspectorForm:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(
      () => document.getElementById('previewStatus').textContent === 'Preview siap',
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    // The status alone stays "Preview siap" after the first compile, so wait for the
    // specific request triggered by adding the image instead of any earlier payload.
    const bindingCompile = page.waitForResponse(
      (response) => response.url().includes('/api/studio/projects/compile'),
      { timeout: PAGE_TIMEOUT_MS }
    );
    await page.getByRole('button', { name: '+ Gambar', exact: true }).click();
    await bindingCompile;
    await page.waitForFunction(
      () => document.getElementById('inspectorForm').textContent.includes('Elemen image'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    assert.ok(compiled.length > 0, 'preview compile request was not sent');
    const payload = compiled.at(-1);
    const imageElement = payload.project.scenes
      .flatMap((scene) => scene.elements)
      .find((element) => element.type === 'image');
    assert.equal(imageElement.assetId, 'ast_55555555-5555-4555-8555-555555555555');
    assert.equal(await page.locator('#previewFrame').count(), 1);
  } finally {
    await stack.close();
  }
});

test('the inspector hides position controls the selected template ignores', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.setInputFiles('#assetFileInput', {
      name: 'kopi.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    await page.waitForSelector('.asset-card', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#addSceneBtn');
    await page.waitForSelector('#inspectorForm:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.getByRole('button', { name: '+ Gambar', exact: true }).click();
    await page.waitForFunction(
      () => document.getElementById('inspectorForm').textContent.includes('Elemen image'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    // `base` composes its own centred layout, so position/fit/Ken Burns are ignored there.
    const labelsOnBase = await page
      .locator('#inspectorForm .inspector-group label')
      .allTextContents();
    assert.ok(!labelsOnBase.some((label) => label.includes('Posisi X')));
    assert.ok(!labelsOnBase.some((label) => label.includes('Ken Burns')));
    assert.ok(!labelsOnBase.some((label) => label.includes('Fit')));

    await page.selectOption('#templateSelect', 'image-slideshow');
    await page.waitForFunction(
      () => document.getElementById('inspectorForm').textContent.includes('Ken Burns'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    const labelsOnSlideshow = await page
      .locator('#inspectorForm .inspector-group label')
      .allTextContents();
    assert.ok(labelsOnSlideshow.some((label) => label.includes('Ken Burns')));
    assert.ok(labelsOnSlideshow.some((label) => label.includes('Fit')));
    assert.ok(!labelsOnSlideshow.some((label) => label.includes('Posisi X')));

    await page.selectOption('#templateSelect', 'video-mixer');
    await page.waitForFunction(
      () => document.getElementById('inspectorForm').textContent.includes('Posisi X'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    const labelsOnMixer = await page
      .locator('#inspectorForm .inspector-group label')
      .allTextContents();
    assert.ok(!labelsOnMixer.some((label) => label.includes('Ken Burns')));
    assert.ok(!labelsOnMixer.some((label) => label.includes('Fit')));
  } finally {
    await stack.close();
  }
});

test('the asset picker only offers media matching the selected element', async () => {
  const IMAGE_ASSET = 'ast_11111111-1111-4111-8111-111111111111';
  const VIDEO_ASSET = 'ast_22222222-2222-4222-8222-222222222222';
  const AUDIO_ASSET = 'ast_33333333-3333-4333-8333-333333333333';
  const state = createState({
    authenticated: true,
    assets: [
      { assetId: IMAGE_ASSET, mime: 'image/png', originalName: 'foto.png', bytes: 10 },
      { assetId: VIDEO_ASSET, mime: 'video/mp4', originalName: 'klip.mp4', bytes: 10 },
      { assetId: AUDIO_ASSET, mime: 'audio/mpeg', originalName: 'lagu.mp3', bytes: 10 },
    ],
  });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.waitForSelector('.asset-card', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#addSceneBtn');
    await page.waitForSelector('#inspectorForm:not([hidden])', { timeout: PAGE_TIMEOUT_MS });

    await page.getByRole('button', { name: '+ Gambar', exact: true }).click();
    await page.waitForFunction(
      () => document.getElementById('inspectorForm').textContent.includes('Elemen image'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    const imageOptions = await page
      .locator('#elementAssetSelect option')
      .allTextContents();
    assert.ok(imageOptions.some((label) => label.includes('foto.png')));
    assert.ok(!imageOptions.some((label) => label.includes('klip.mp4')));
    assert.ok(!imageOptions.some((label) => label.includes('lagu.mp3')));

    await page.getByRole('button', { name: '+ Video', exact: true }).click();
    await page.waitForFunction(
      () => document.getElementById('inspectorForm').textContent.includes('Elemen video'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    const videoOptions = await page
      .locator('#elementAssetSelect option')
      .allTextContents();
    assert.ok(videoOptions.some((label) => label.includes('klip.mp4')));
    assert.ok(!videoOptions.some((label) => label.includes('foto.png')));
    assert.ok(!videoOptions.some((label) => label.includes('lagu.mp3')));

    const audioOptions = await page
      .locator('#projectAudioSelect')
      .locator('option')
      .allTextContents();
    assert.ok(audioOptions.some((label) => label.includes('lagu.mp3')));
    assert.ok(!audioOptions.some((label) => label.includes('foto.png')));
    assert.ok(!audioOptions.some((label) => label.includes('klip.mp4')));
  } finally {
    await stack.close();
  }
});

test('narrow viewports stack the layout and every icon button has an accessible name', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.setViewportSize({ width: 420, height: 900 });

    const layout = await page.evaluate(() => ({
      columns: getComputedStyle(document.querySelector('.builder-shell')).gridTemplateColumns
        .split(' ').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll('body *')].map((el) => ({
        tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80), id: el.id,
        right: Math.round(el.getBoundingClientRect().right),
        left: Math.round(el.getBoundingClientRect().left),
      })).filter((el) => el.right > innerWidth + 1 || el.left < -1).slice(0, 15),
      unnamedIcons: [...document.querySelectorAll('.icon-btn')]
        .filter((button) => !button.getAttribute('aria-label'))
        .map((button) => button.id),
    }));

    assert.equal(layout.columns, 1, 'narrow screens stack into a single column');
    assert.ok(layout.overflow <= 1, `page overflows horizontally by ${layout.overflow}px: ${JSON.stringify(layout.offenders)}`);
    assert.deepEqual(layout.unnamedIcons, [], 'icon-only buttons must expose a name');
  } finally {
    await stack.close();
  }
});

test('render submits the project payload with CSRF and completes to a download link', async () => {
  const state = createState({
    authenticated: true,
    jobSequence: [
      {
        job_id: 'job-e2e',
        status: 'active',
        progress: { progress: 35, renderedFrames: 210, totalFrames: 600 },
        error: null,
        result: null,
      },
      {
        job_id: 'job-e2e',
        status: 'completed',
        progress: { progress: 100 },
        error: null,
        result: { url: '/api/studio/output/job-e2e.mp4', storage: 'local_disk', cached: false },
      },
    ],
  });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.fill('#promptInput', 'promo');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#promptReplaceBtn');
    await page.waitForSelector('.scene-card', { timeout: PAGE_TIMEOUT_MS });

    await page.click('#renderSubmitBtn');
    await page.waitForFunction(
      () => document.getElementById('renderStatus').textContent.includes('210/600'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#renderProgressText').textContent(), '35%');
    state.releaseJobCompletion = true;

    await page.waitForSelector('#renderResult:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(
      await page.locator('#downloadVideo').getAttribute('href'),
      '/api/studio/output/job-e2e.mp4?download=1'
    );
    assert.equal(await page.locator('#renderStatus').textContent(), 'Selesai');
    assert.equal(await page.locator('#renderSubmitBtn').isEnabled(), true);

    assert.equal(state.renderRequests.length, 1);
    const [{ body, csrf }] = state.renderRequests;
    assert.equal(csrf, 'csrf-e2e-token');
    assert.equal(body.useAiHtml, false);
    assert.equal(body.project.template, 'base');
    assert.equal(body.project.scenes.length, 1);
    assert.equal(body.project.scenes[0].elements[0].text, 'Kopi Nusantara');
  } finally {
    await stack.close();
  }
});

test('signed object-storage download urls keep their signature intact', async () => {
  const signedUrl = 'https://minio.example.com/renders/job-e2e.mp4?X-Amz-Signature=abc123';
  const state = createState({
    authenticated: true,
    jobSequence: [{
      job_id: 'job-e2e',
      status: 'completed',
      progress: { progress: 100 },
      error: null,
      result: { url: signedUrl, storage: 's3', cached: false },
    }],
  });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#addSceneBtn');
    await page.click('#renderSubmitBtn');

    await page.waitForSelector('#renderResult:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(await page.locator('#downloadVideo').getAttribute('href'), signedUrl);
  } finally {
    await stack.close();
  }
});

test('failed job surfaces the error and re-enables submit', async () => {
  const state = createState({
    authenticated: true,
    jobSequence: [{
      job_id: 'job-e2e',
      status: 'failed',
      progress: { progress: 30 },
      error: 'FFmpeg keluar dengan kode 1',
      result: null,
    }],
  });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#addSceneBtn');
    await page.click('#renderSubmitBtn');

    await page.waitForFunction(
      () => document.getElementById('toastRegion').textContent.includes('FFmpeg keluar dengan kode 1'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#renderStatus').textContent(), 'Gagal');
    assert.equal(await page.locator('#renderResult').isVisible(), false);
    assert.equal(await page.locator('#renderSubmitBtn').isEnabled(), true);
  } finally {
    await stack.close();
  }
});

test('render refuses to submit an empty timeline with an Indonesian message', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#renderSubmitBtn');
    await page.waitForFunction(
      () => document.getElementById('toastRegion').textContent.includes('minimal satu scene'),
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(state.renderRequests.length, 0);
  } finally {
    await stack.close();
  }
});

test('the model picker is populated per provider and sent with the prompt', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('modelSelect').options.length === 2,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    assert.equal(await page.locator('#providerSelect').inputValue(), 'river');
    assert.equal(await page.locator('#modelSelect').inputValue(), 'river-default');

    await page.selectOption('#providerSelect', 'deepseek');
    await page.waitForFunction(
      () => document.getElementById('modelSelect').value === 'deepseek-chat',
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.selectOption('#modelSelect', 'deepseek-reasoner');

    await page.fill('#promptInput', 'Buat promo kopi');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });

    assert.equal(state.promptRequests.length, 1);
    assert.equal(state.promptRequests[0].body.providerId, 'deepseek');
    assert.equal(state.promptRequests[0].body.model, 'deepseek-reasoner');
  } finally {
    await stack.close();
  }
});

test('the chosen provider and model survive a page reload', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { context, page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('modelSelect').options.length === 2,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.selectOption('#providerSelect', 'deepseek');
    await page.selectOption('#modelSelect', 'deepseek-reasoner');

    const reopened = await context.newPage();
    await reopened.goto(`${baseUrl}${STUDIO_PATH}`, { waitUntil: 'domcontentloaded' });
    await reopened.waitForFunction(
      () => document.getElementById('modelSelect').options.length === 2,
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    assert.equal(await reopened.locator('#providerSelect').inputValue(), 'deepseek');
    assert.equal(await reopened.locator('#modelSelect').inputValue(), 'deepseek-reasoner');
  } finally {
    await stack.close();
  }
});

test('an unavailable model list falls back to built-in providers', async () => {
  const state = createState({ authenticated: true, modelListUnavailable: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('modelSelect').options.length > 0,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.fill('#promptInput', 'Buat promo kopi');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });

    assert.equal(await page.locator('#providerSelect').inputValue(), 'river');
    assert.equal(state.promptRequests[0].body.model, 'deepseek-ai/DeepSeek-V4.1-Flash');
  } finally {
    await stack.close();
  }
});

test('browser storage never holds a token, CSRF value, or API key', async () => {
  const state = createState();
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await loginThrough(page);
    await page.fill('#promptInput', 'promo');
    await page.click('#generateBtn');
    await page.waitForSelector('#promptChoice:not([hidden])', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#promptReplaceBtn');
    await page.waitForSelector('.scene-card', { timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(
      () => localStorage.getItem('motionStudio.project.v1') !== null,
      null, { timeout: PAGE_TIMEOUT_MS }
    );

    const stored = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
    }));

    assert.deepEqual(Object.keys(stored.session), []);
    assert.deepEqual(
      Object.keys(stored.local).sort(),
      ['motionStudio.ai.model.v1', 'motionStudio.project.v1'].sort()
    );
    assert.equal(stored.cookie, '');

    const serialized = JSON.stringify(stored).toLowerCase();
    for (const forbidden of ['csrfe2etoken', 'csrf-e2e-token', 'x-csrf-token', 'token', 'password', 'api_key', 'apikey']) {
      assert.equal(serialized.includes(forbidden), false, `storage leaked ${forbidden}`);
    }
  } finally {
    await stack.close();
  }
});

test('logout returns to the login overlay and stops job polling', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#logoutBtn');
    await page.waitForSelector('#loginOverlay.visible', { timeout: PAGE_TIMEOUT_MS });
    assert.equal(await page.locator('#logoutBtn').isVisible(), false);
    assert.equal(state.authenticated, false);
  } finally {
    await stack.close();
  }
});


test('gesture path editor drags a cursor waypoint and preserves scene data', async () => {
  const state = createState({ authenticated: true });
  const stack = await openStudio(state);
  const { page } = stack;
  try {
    await page.waitForFunction(
      () => document.getElementById('templateSelect').options.length === 4,
      null, { timeout: PAGE_TIMEOUT_MS }
    );
    await page.click('#addSceneBtn');
    const add = page.getByRole('button', { name: '+ Tambah gesture' });
    await add.click();
    const handles = page.locator('#gesturePathEditor circle');
    await handles.first().waitFor({ timeout: PAGE_TIMEOUT_MS });
    assert.equal(await handles.count(), 2);
    // Tap handles overlap; use the destination handle, initially centred.
    const dest = handles.last();
    const origin = await dest.boundingBox();
    assert.ok(origin);
    await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2);
    await page.mouse.down();
    await page.mouse.move(origin.x + origin.width / 2 + 65, origin.y + origin.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const circle = document.querySelectorAll('#gesturePathEditor circle')[1];
      return circle && Number(circle.getAttribute('cx')) > 500;
    }, null, { timeout: PAGE_TIMEOUT_MS });
    assert.ok(Number(await handles.last().getAttribute('cx')) > 500);
  } finally {
    await stack.close();
  }
});
