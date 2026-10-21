import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  PromptUnavailableError,
  SceneAiOutputError,
  generateSceneDraft,
} from '../vps-server/studio/scene-ai.js';
import { createStudioRouter } from '../vps-server/studio-routes.js';

function validDraft(overrides = {}) {
  return {
    title: 'Promo Kopi',
    template: 'image-slideshow',
    scenes: [{
      durationSec: 5,
      elements: [{ type: 'text', role: 'title', text: 'Kopi Nusantara' }],
    }],
    ...overrides,
  };
}

test('generateSceneDraft parses and normalizes provider JSON', async () => {
  const calls = [];
  const result = await generateSceneDraft('Buat promo kopi elegan', {
    hasApiKey: async () => true,
    callChat: async (options) => {
      calls.push(options);
      return {
        content: `\`\`\`json\n${JSON.stringify(validDraft())}\n\`\`\``,
        providerId: 'river',
        model: 'scene-model',
      };
    },
  });

  assert.equal(result.project.title, 'Promo Kopi');
  assert.equal(result.project.schemaVersion, 1);
  assert.match(result.project.projectId, /^prj_/);
  assert.equal(result.providerId, 'river');
  assert.equal(result.model, 'scene-model');
  assert.equal(calls[0].stream, false);
  assert.equal(calls[0].temperature, 0.2);
  assert.match(calls[0].messages[0].content, /JSON/i);
});

test('unknown AI fields are discarded by project normalization', async () => {
  const result = await generateSceneDraft('Promo', {
    hasApiKey: async () => true,
    callChat: async () => ({
      content: JSON.stringify(validDraft({
        dangerous: '<script>',
        scenes: [{
          elements: [{ type: 'text', text: 'Aman', unknown: 'drop' }],
          unknown: 'drop',
        }],
      })),
      providerId: 'deepseek',
      model: 'deepseek-chat',
    }),
  });

  assert.equal(result.project.dangerous, undefined);
  assert.equal(result.project.scenes[0].unknown, undefined);
  assert.equal(result.project.scenes[0].elements[0].unknown, undefined);
});

test('missing provider key fails before any network call', async () => {
  let called = false;
  await assert.rejects(
    () => generateSceneDraft('Promo', {
      hasApiKey: async () => false,
      callChat: async () => { called = true; },
    }),
    (error) => error instanceof PromptUnavailableError
  );
  assert.equal(called, false);
});

test('invalid provider output maps to SceneAiOutputError', async () => {
  await assert.rejects(
    () => generateSceneDraft('Promo', {
      hasApiKey: async () => true,
      callChat: async () => ({ content: 'not json', providerId: 'river', model: 'x' }),
    }),
    (error) => error instanceof SceneAiOutputError && /JSON|struktur/i.test(error.message)
  );
});

test('prompt validation rejects empty and oversized input without provider calls', async () => {
  let calls = 0;
  const options = {
    hasApiKey: async () => true,
    callChat: async () => { calls += 1; },
  };
  await assert.rejects(() => generateSceneDraft('   ', options), /prompt/i);
  await assert.rejects(() => generateSceneDraft('x'.repeat(4001), options), /prompt|karakter/i);
  assert.equal(calls, 0);
});

async function startServer(generateScene) {
  const app = express();
  app.use(express.json());
  app.use('/api/studio', createStudioRouter({
    authenticate: (req, _res, next) => {
      req.adminActor = 'Studio Admin';
      req.adminSession = { csrfToken: 'csrf-token' };
      next();
    },
    requireCsrf: (req, res, next) => req.headers['x-csrf-token'] === 'csrf-token'
      ? next()
      : res.status(403).json({ error: 'Token CSRF tidak valid' }),
    promptLimiter: (_req, _res, next) => next(),
    generateScene,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function promptRequest(baseUrl, prompt, csrf = true) {
  return fetch(`${baseUrl}/api/studio/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': 'csrf-token' } : {}),
    },
    body: JSON.stringify({ prompt }),
  });
}

test('prompt route returns normalized project and provider metadata', async (context) => {
  const stack = await startServer(async () => ({
    project: validDraft(), providerId: 'river', model: 'scene-model',
  }));
  context.after(stack.close);

  const response = await promptRequest(stack.baseUrl, 'Promo kopi');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    project: validDraft(), providerId: 'river', model: 'scene-model',
  });

  const noCsrf = await promptRequest(stack.baseUrl, 'Promo kopi', false);
  assert.equal(noCsrf.status, 403);
});

test('prompt route maps provider and output failures', async (context) => {
  for (const [error, status] of [
    [new PromptUnavailableError(), 503],
    [new SceneAiOutputError('Struktur scene AI tidak valid'), 422],
    [new Error('Prompt wajib diisi'), 400],
  ]) {
    const stack = await startServer(async () => { throw error; });
    const response = await promptRequest(stack.baseUrl, 'Promo kopi');
    await stack.close();
    assert.equal(response.status, status);
    assert.ok((await response.json()).error);
  }
  context.after(() => {});
});
