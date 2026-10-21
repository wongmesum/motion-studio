import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStudioRouter } from '../vps-server/studio-routes.js';
import {
  ProjectConflictError,
  ProjectNotFoundError,
} from '../vps-server/studio/project-store.js';

const PROJECT_ID = 'prj_11111111-1111-4111-8111-111111111111';

function project(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    title: 'Promo Kopi',
    template: 'base',
    render: { duration: 10, fps: 30, width: 1280, height: 720, codec: 'h264' },
    theme: {
      backgroundColor: '#070913',
      primaryColor: '#38bdf8',
      accentColor: '#a855f7',
      fontFamily: 'Inter',
    },
    scenes: [{ elements: [{ type: 'text', text: 'Halo' }] }],
    ...overrides,
  };
}

function authenticate(req, _res, next) {
  req.adminActor = 'Studio Admin';
  req.adminSession = { csrfToken: 'csrf-token' };
  next();
}

function requireCsrf(req, res, next) {
  if (req.headers['x-csrf-token'] !== 'csrf-token') {
    return res.status(403).json({ error: 'Token CSRF tidak valid' });
  }
  next();
}

function createProjectStore(overrides = {}) {
  return {
    create: async () => ({ project: project(), revision: 1 }),
    list: async () => [{ projectId: PROJECT_ID, title: 'Promo Kopi', revision: 1 }],
    get: async () => ({ project: project(), revision: 1 }),
    update: async (_actor, _id, input) => ({ project: input.project, revision: 2 }),
    remove: async () => undefined,
    ...overrides,
  };
}

async function startServer(options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/studio', createStudioRouter({
    authenticate,
    requireCsrf,
    rateLimit: (_req, _res, next) => next(),
    projectStore: createProjectStore(),
    ...options,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function request(baseUrl, route, options = {}) {
  return fetch(`${baseUrl}/api/studio${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
}

function mutation(baseUrl, route, method, body) {
  return request(baseUrl, route, {
    method,
    headers: { 'X-CSRF-Token': 'csrf-token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('project CRUD routes preserve actor ownership and revisions', async (context) => {
  const calls = [];
  const projectStore = createProjectStore({
    create: async (actor, input) => {
      calls.push(['create', actor, input]);
      return { project: project(), revision: 1 };
    },
    list: async (actor) => {
      calls.push(['list', actor]);
      return [{ projectId: PROJECT_ID, title: 'Promo Kopi', revision: 1 }];
    },
    get: async (actor, projectId) => {
      calls.push(['get', actor, projectId]);
      return { project: project(), revision: 1 };
    },
    update: async (actor, projectId, input) => {
      calls.push(['update', actor, projectId, input]);
      return { project: input.project, revision: 2 };
    },
    remove: async (actor, projectId) => {
      calls.push(['remove', actor, projectId]);
    },
  });
  const stack = await startServer({ projectStore });
  context.after(stack.close);

  const created = await mutation(stack.baseUrl, '/projects', 'POST', { project: project() });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).revision, 1);

  const listed = await request(stack.baseUrl, '/projects');
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).projects.length, 1);

  const loaded = await request(stack.baseUrl, `/projects/${PROJECT_ID}`);
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).project.projectId, PROJECT_ID);

  const updated = await mutation(stack.baseUrl, `/projects/${PROJECT_ID}`, 'PUT', {
    baseRevision: 1,
    project: project({ title: 'Baru' }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).revision, 2);

  const removed = await mutation(stack.baseUrl, `/projects/${PROJECT_ID}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });

  assert.ok(calls.every((call) => call[1] === 'Studio Admin'));
});

test('all project mutations require CSRF', async (context) => {
  const stack = await startServer();
  context.after(stack.close);

  for (const [route, method, body] of [
    ['/projects', 'POST', { project: project() }],
    [`/projects/${PROJECT_ID}`, 'PUT', { baseRevision: 1, project: project() }],
    [`/projects/${PROJECT_ID}`, 'DELETE', undefined],
    ['/projects/compile', 'POST', { project: project() }],
    ['/projects/validate', 'POST', { project: project() }],
  ]) {
    const response = await request(stack.baseUrl, route, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 403, `${method} ${route}`);
  }
});

test('project not-found and revision conflicts have stable API responses', async (context) => {
  const projectStore = createProjectStore({
    get: async () => null,
    update: async () => {
      throw new ProjectConflictError(4, project());
    },
    remove: async () => {
      throw new ProjectNotFoundError();
    },
  });
  const stack = await startServer({ projectStore });
  context.after(stack.close);

  const missing = await request(stack.baseUrl, `/projects/${PROJECT_ID}`);
  assert.equal(missing.status, 404);

  const conflict = await mutation(stack.baseUrl, `/projects/${PROJECT_ID}`, 'PUT', {
    baseRevision: 1,
    project: project(),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: 'Project sudah diubah oleh sesi lain',
    currentRevision: 4,
    project: project(),
  });

  const removed = await mutation(stack.baseUrl, `/projects/${PROJECT_ID}`, 'DELETE');
  assert.equal(removed.status, 404);
});

test('validate route normalizes an imported draft without persisting it', async (context) => {
  const stack = await startServer();
  context.after(stack.close);

  const imported = project({
    projectId: undefined,
    render: { duration: 99, fps: 30, width: 1280, height: 720, codec: 'h264' },
    scenes: [{ durationSec: 3, elements: [{ type: 'text', text: 'Halo' }] }],
    extraField: 'dropped',
    localPath: 'C:\\renders\\promo.mp4',
  });

  const response = await mutation(stack.baseUrl, '/projects/validate', 'POST', {
    project: imported,
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.project.projectId.startsWith('prj_'), true);
  assert.equal(body.project.render.duration, 3);
  assert.equal(body.project.extraField, undefined);
  assert.equal(body.project.localPath, undefined);
  assert.match(body.project.scenes[0].id, /^scn_/);
  assert.match(body.project.scenes[0].elements[0].id, /^el_/);

  const invalid = await mutation(stack.baseUrl, '/projects/validate', 'POST', {
    project: { template: '../../etc/passwd' },
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Template tidak valid/);
});

test('validate route re-mints the project id so an import never targets the source', async (context) => {
  const stack = await startServer();
  context.after(stack.close);

  const source = project();
  const response = await mutation(stack.baseUrl, '/projects/validate', 'POST', {
    project: source,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.notEqual(body.project.projectId, source.projectId);
  assert.match(body.project.projectId, /^prj_/);
});

test('compile endpoint returns preview HTML only', async (context) => {
  const calls = [];
  const stack = await startServer({
    compileProject: async (input, options) => {
      calls.push({ input, options });
      return { html: '<!DOCTYPE html><p>preview</p>', project: input, target: options.target };
    },
  });
  context.after(stack.close);

  const response = await mutation(stack.baseUrl, '/projects/compile', 'POST', {
    project: project(),
    target: 'render',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    html: '<!DOCTYPE html><p>preview</p>',
    warnings: [],
  });
  assert.equal(calls[0].options.target, 'preview');
});

test('builder render compiles server-side HTML and bypasses engineer rewrite', async (context) => {
  const queued = [];
  const compileCalls = [];
  const stack = await startServer({
    compileProject: async (input, options) => {
      compileCalls.push({ input, options });
      return { html: '<!DOCTYPE html><p>render</p>', project: input, target: 'render' };
    },
    enqueueJob: async (payload) => {
      queued.push(payload);
      return { job_id: 'builder-job', status: 'queued' };
    },
  });
  context.after(stack.close);

  const response = await mutation(stack.baseUrl, '/render', 'POST', { project: project() });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { job_id: 'builder-job', status: 'queued' });
  assert.equal(compileCalls[0].options.target, 'render');
  assert.deepEqual(queued[0], {
    template: 'base',
    duration: 10,
    fps: 30,
    width: 1280,
    height: 720,
    codec: 'h264',
    html: '<!DOCTYPE html><p>render</p>',
    skipEngineer: true,
    submittedBy: 'Studio Admin',
  });
});

test('builder render queues server-only audio path alongside sanitized HTML', async (context) => {
  const queued = [];
  const stack = await startServer({
    compileProject: async (input, options) => {
      assert.equal(options.target, 'render');
      return {
        html: '<!DOCTYPE html><p>render</p>',
        project: input,
        target: 'render',
        audioLocalPath: '/trusted/uploads/audio.mp3',
      };
    },
    enqueueJob: async (payload) => {
      queued.push(payload);
      return { job_id: 'audio-job', status: 'queued' };
    },
  });
  context.after(stack.close);

  const response = await mutation(stack.baseUrl, '/render', 'POST', { project: project() });
  assert.equal(response.status, 202);
  assert.equal(queued[0].audioLocalPath, '/trusted/uploads/audio.mp3');
  // The browser-facing payload must never contain the filesystem path.
  assert.ok(!queued[0].html.includes('/trusted/uploads'));
});

test('legacy render payload stays backward compatible', async (context) => {
  const queued = [];
  const stack = await startServer({
    readTemplate: async () => '<!DOCTYPE html><p>legacy</p>',
    enqueueJob: async (payload) => {
      queued.push(payload);
      return { job_id: 'legacy-job', status: 'queued' };
    },
  });
  context.after(stack.close);

  const response = await mutation(stack.baseUrl, '/render', 'POST', {
    template: 'base', duration: 10, fps: 30, width: 1280, height: 720, codec: 'h264',
  });
  assert.equal(response.status, 202);
  assert.equal(queued[0].html, '<!DOCTYPE html><p>legacy</p>');
  assert.equal('engineer' in queued[0], false);
});

test('builder render resolves asset ids through the owner-scoped store', async (context) => {
  const compileCalls = [];
  const queue = [];
  const stack = await startServer({
    assetStore: {
      readPath: async (_actor, assetId) => (assetId === 'ast_known' ? '/app/vps-server/data/uploads/x.png' : null),
    },
    compileProject: async (input, options) => {
      compileCalls.push(options);
      await options.resolveAsset('ast_known');
      return { html: '<!DOCTYPE html><p>render</p>', project: input, target: 'render' };
    },
    enqueueJob: async (payload) => {
      queue.push(payload);
      return { job_id: 'asset-job', status: 'queued' };
    },
  });
  context.after(stack.close);

  const response = await mutation(stack.baseUrl, '/render', 'POST', { project: project() });
  assert.equal(response.status, 202);
  assert.equal(typeof compileCalls[0].resolveAsset, 'function');

  // A foreign or expired id must fail the compile rather than silently resolving.
  const resolver = compileCalls[0].resolveAsset;
  await assert.rejects(() => resolver('ast_missing'), /tidak ditemukan|kedaluwarsa/i);
});

test('compile endpoint also checks asset ownership', async (context) => {
  const compileCalls = [];
  const stack = await startServer({
    assetStore: { readPath: async () => null },
    compileProject: async (input, options) => {
      compileCalls.push(options);
      await options.resolveAsset('ast_missing');
      return { html: '<p>never</p>', project: input, target: options.target };
    },
  });
  context.after(stack.close);

  const response = await mutation(stack.baseUrl, '/projects/compile', 'POST', {
    project: project(),
  });
  assert.equal(response.status, 400);
  assert.equal(typeof compileCalls[0].resolveAsset, 'function');
});
