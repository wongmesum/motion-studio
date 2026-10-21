import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStudioRouter } from '../vps-server/studio-routes.js';

/**
 * The studio `/models` endpoint exposes provider+model choices to the browser without ever
 * revealing the API key that powers them. `/prompt` accepts an optional model only when it
 * matches the provider's catalog, so a client cannot pick an arbitrary (or mistaken) model id.
 */

const RIVER_MODELS = [
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'deepseek-ai/DeepSeek-V4.1-Flash', source: 'default' },
  { id: 'river-extra', label: 'river-extra', source: 'env' },
];

function fakeRegistry(overrides = {}) {
  const providers = {
    river: { defaultModel: RIVER_MODELS[0].id, models: RIVER_MODELS },
    deepseek: {
      defaultModel: 'deepseek-chat',
      models: [{ id: 'deepseek-chat', label: 'deepseek-chat', source: 'default' }],
    },
  };
  return {
    listProviders: async () => ({
      providers: [
        {
          id: 'river',
          label: 'River AI',
          configured: true,
          defaultModel: providers.river.defaultModel,
          models: providers.river.models,
        },
        {
          id: 'deepseek',
          label: 'DeepSeek Official',
          configured: false,
          defaultModel: providers.deepseek.defaultModel,
          models: providers.deepseek.models,
        },
      ],
    }),
    getModels: async (providerId) => {
      if (!providers[providerId]) throw new Error(`Unsupported AI provider: ${providerId}`);
      return providers[providerId];
    },
    isAllowed: async (providerId, modelId) =>
      providers[providerId]?.models.some((model) => model.id === modelId) ?? false,
    ...overrides,
  };
}

const AUTHENTICATE = (req, _res, next) => {
  req.adminActor = 'Studio Admin';
  req.adminSession = { csrfToken: 'csrf-token' };
  next();
};

const REJECT = (_req, res) => res.status(401).json({ error: 'Unauthorized' });

const CSRF = (req, res, next) =>
  req.headers['x-csrf-token'] === 'csrf-token'
    ? next()
    : res.status(403).json({ error: 'Token CSRF tidak valid' });

async function startServer(options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/studio', createStudioRouter({
    authenticate: options.authenticate || AUTHENTICATE,
    requireCsrf: CSRF,
    promptLimiter: (_req, _res, next) => next(),
    generateScene: options.generateScene || (async () => ({ ok: true })),
    modelRegistry: options.modelRegistry || fakeRegistry(),
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function get(baseUrl, route) {
  return fetch(`${baseUrl}/api/studio${route}`);
}

function prompt(baseUrl, body, csrf = true) {
  return fetch(`${baseUrl}/api/studio/prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-CSRF-Token': 'csrf-token' } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('GET /models requires an authenticated session', async (context) => {
  const stack = await startServer({ authenticate: REJECT });
  context.after(stack.close);

  const response = await get(stack.baseUrl, '/models');

  assert.equal(response.status, 401);
});

test('GET /models returns provider choices without any credential field', async (context) => {
  const stack = await startServer();
  context.after(stack.close);

  const response = await get(stack.baseUrl, '/models');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.providers.map((provider) => provider.id), ['river', 'deepseek']);
  assert.equal(body.providers[0].label, 'River AI');
  assert.equal(body.providers[0].defaultModel, RIVER_MODELS[0].id);
  assert.deepEqual(body.providers[0].models, RIVER_MODELS);

  const serialized = JSON.stringify(body).toLowerCase();
  for (const forbidden of ['apikey', 'api_key', 'token', 'secret', 'bearer']) {
    assert.equal(serialized.includes(forbidden), false, `models leaked ${forbidden}`);
  }
});

test('POST /prompt forwards a catalog model to the generator', async (context) => {
  const calls = [];
  const stack = await startServer({
    generateScene: async (promptValue, options) => {
      calls.push({ promptValue, options });
      return { project: { title: 'x' }, providerId: 'river', model: 'river-extra' };
    },
  });
  context.after(stack.close);

  const response = await prompt(stack.baseUrl, {
    prompt: 'Buat promo',
    providerId: 'river',
    model: 'river-extra',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], {
    promptValue: 'Buat promo',
    options: { providerId: 'river', model: 'river-extra' },
  });
});

test('POST /prompt rejects a model outside the provider catalog', async (context) => {
  let generated = false;
  const stack = await startServer({
    generateScene: async () => { generated = true; return {}; },
  });
  context.after(stack.close);

  const response = await prompt(stack.baseUrl, {
    prompt: 'Buat promo',
    providerId: 'river',
    model: 'not-a-real-model',
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Model AI tidak didukung untuk provider ini/);
  assert.equal(generated, false);
});

test('POST /prompt without a model keeps the previous default behaviour', async (context) => {
  const calls = [];
  const stack = await startServer({
    generateScene: async (promptValue, options) => {
      calls.push(options);
      return { project: { title: 'x' }, providerId: 'deepseek', model: 'deepseek-chat' };
    },
  });
  context.after(stack.close);

  const response = await prompt(stack.baseUrl, { prompt: 'Buat promo', providerId: 'deepseek' });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], { providerId: 'deepseek' });
});

test('POST /prompt with an unknown provider is still rejected', async (context) => {
  const stack = await startServer();
  context.after(stack.close);

  const response = await prompt(stack.baseUrl, { prompt: 'Buat promo', providerId: 'gemini' });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Provider/i);
});
