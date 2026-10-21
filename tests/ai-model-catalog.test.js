import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRegistry } from '../vps-server/ai/model-catalog.js';

/**
 * The registry is the only place that knows which models a provider offers. It must always
 * hold a usable entry (the configured default), never leak the API key it discovers with,
 * and never let a provider outage remove every selectable model.
 */

const RIVER_DEFAULT = 'deepseek-ai/DeepSeek-V4.1-Flash';
const DEEPSEEK_DEFAULT = 'deepseek-chat';

const CONFIGS = {
  river: {
    providerId: 'river',
    provider: 'River AI',
    baseUrl: 'https://api.river.ai',
    apiKey: 'river-secret-key',
    model: RIVER_DEFAULT,
  },
  deepseek: {
    providerId: 'deepseek',
    provider: 'DeepSeek Official',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'deepseek-secret-key',
    model: DEEPSEEK_DEFAULT,
  },
};

function getConfig(providerId) {
  const config = CONFIGS[providerId];
  if (!config) return Promise.reject(new Error(`Unsupported AI provider: ${providerId}`));
  return Promise.resolve({ ...config });
}

function createTransport({ ids = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    get: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw new Error('provider unreachable');
      return { data: { data: ids.map((id) => ({ id })) } };
    },
  };
}

const ids = (models) => models.map((model) => model.id);

test('the configured default model is always the first entry', async () => {
  const registry = createModelRegistry({ getConfig, env: { RIVER_MODELS: 'extra-a,extra-b' } });

  const { defaultModel, models } = await registry.getModels('river');

  assert.equal(defaultModel, RIVER_DEFAULT);
  assert.deepEqual(ids(models), [RIVER_DEFAULT, 'extra-a', 'extra-b']);
  assert.equal(models[0].source, 'default');
  assert.equal(models[1].source, 'env');
});

test('env model lists are trimmed, deduplicated, and never displace the default', async () => {
  const registry = createModelRegistry({
    getConfig,
    env: { DEEPSEEK_MODELS: ` ${DEEPSEEK_DEFAULT}, deepseek-reasoner ,,deepseek-reasoner` },
  });

  const { models } = await registry.getModels('deepseek');

  assert.deepEqual(ids(models), [DEEPSEEK_DEFAULT, 'deepseek-reasoner']);
});

test('a provider with no env additions still offers its default model', async () => {
  const registry = createModelRegistry({ getConfig, env: {} });

  const { models } = await registry.getModels('deepseek');

  assert.deepEqual(ids(models), [DEEPSEEK_DEFAULT]);
});

test('an unknown provider is rejected instead of silently falling back', async () => {
  const registry = createModelRegistry({ getConfig, env: {} });

  await assert.rejects(() => registry.getModels('gemini'), /Unsupported AI provider/);
  await assert.rejects(() => registry.discover('gemini'), /Unsupported AI provider/);
});

test('discovery stays offline unless it is explicitly enabled', async () => {
  const transport = createTransport({ ids: ['extra-a'] });
  const registry = createModelRegistry({ getConfig, transport, env: {} });

  const { models } = await registry.getModels('river');

  assert.equal(transport.calls.length, 0, 'the default boot path must not depend on the provider network');
  assert.deepEqual(ids(models), [RIVER_DEFAULT]);
});

test('enabled discovery merges provider models after the static catalog', async () => {
  const transport = createTransport({ ids: ['extra-a', RIVER_DEFAULT] });
  const registry = createModelRegistry({
    getConfig,
    transport,
    env: { AI_MODELS_DISCOVERY: 'true' },
  });

  const { models } = await registry.getModels('river');

  assert.deepEqual(ids(models), [RIVER_DEFAULT, 'extra-a']);
  assert.equal(models[1].source, 'discovery');
  assert.equal(transport.calls[0].url, 'https://api.river.ai/v1/models');
  assert.equal(transport.calls[0].options.headers.Authorization, 'Bearer river-secret-key');
});

test('discovered models are cached until the TTL expires', async () => {
  let clock = 1_000;
  const transport = createTransport({ ids: ['extra-a'] });
  const registry = createModelRegistry({
    getConfig,
    transport,
    env: { AI_MODELS_DISCOVERY: 'true', AI_MODELS_CACHE_TTL_MS: '60000' },
    now: () => clock,
  });

  await registry.getModels('river');
  clock += 59_000;
  const cached = await registry.getModels('river');
  assert.equal(transport.calls.length, 1, 'a second read inside the TTL must not re-query the provider');
  assert.deepEqual(ids(cached.models), [RIVER_DEFAULT, 'extra-a']);

  clock += 2_000;
  await registry.getModels('river');
  assert.equal(transport.calls.length, 2, 'an expired entry must be refreshed');
});

test('a failing discovery keeps the static catalog instead of throwing', async () => {
  const transport = createTransport({ fail: true });
  const registry = createModelRegistry({
    getConfig,
    transport,
    env: { AI_MODELS_DISCOVERY: 'true' },
  });

  const discovered = await registry.discover('river');
  const { defaultModel, models } = await registry.getModels('river');

  assert.deepEqual(discovered, []);
  assert.equal(defaultModel, RIVER_DEFAULT);
  assert.deepEqual(ids(models), [RIVER_DEFAULT]);
});

test('discovery never calls the provider without an API key', async () => {
  const transport = createTransport({ ids: ['extra-a'] });
  const registry = createModelRegistry({
    getConfig: async (providerId) => ({ ...(await getConfig(providerId)), apiKey: '' }),
    transport,
    env: { AI_MODELS_DISCOVERY: 'true' },
  });

  await registry.discover('river');

  assert.equal(transport.calls.length, 0);
});

test('the API key never appears in a catalog response', async () => {
  const transport = createTransport({ ids: ['extra-a'] });
  const registry = createModelRegistry({
    getConfig,
    transport,
    env: { AI_MODELS_DISCOVERY: 'true' },
  });

  const payload = await registry.listProviders();
  const serialized = JSON.stringify(payload);

  assert.equal(serialized.includes('river-secret-key'), false);
  assert.equal(serialized.includes('deepseek-secret-key'), false);
  assert.equal(serialized.includes('apiKey'), false);
});

test('listProviders describes every provider with its default and configured state', async () => {
  const registry = createModelRegistry({
    getConfig: async (providerId) => {
      const config = await getConfig(providerId);
      return providerId === 'deepseek' ? { ...config, apiKey: '' } : config;
    },
    env: {},
  });

  const { providers } = await registry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), ['river', 'deepseek']);
  assert.equal(providers[0].label, 'River AI');
  assert.equal(providers[0].configured, true);
  assert.equal(providers[0].defaultModel, RIVER_DEFAULT);
  assert.equal(providers[1].label, 'DeepSeek Official');
  assert.equal(providers[1].configured, false);
  assert.deepEqual(ids(providers[1].models), [DEEPSEEK_DEFAULT]);
});

test('a base URL that already ends in /v1 is not doubled', async () => {
  const transport = createTransport({ ids: [] });
  const registry = createModelRegistry({
    getConfig: async (providerId) => ({
      ...(await getConfig(providerId)),
      baseUrl: 'https://api.deepseek.com/v1',
    }),
    transport,
    env: {},
  });

  await registry.discover('deepseek');

  assert.equal(transport.calls[0].url, 'https://api.deepseek.com/v1/models');
});
