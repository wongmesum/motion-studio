import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-ai-provider-test-'));
await fs.writeFile(
  path.join(dataDir, 'admin-store.json'),
  JSON.stringify({
    riverConfig: {
      provider: 'River AI',
      baseUrl: 'https://legacy-river.example',
      apiKey: 'legacy-river-secret-key',
      model: 'legacy-river-model',
    },
    keyVault: [
      {
        id: 'legacy-key',
        label: 'Legacy River',
        apiKey: 'legacy-vault-secret',
        isActive: true,
      },
    ],
  }),
  'utf8'
);
process.env.MOTION_DATA_DIR = dataDir;
process.env.AI_PROVIDER = 'river';
process.env.RIVER_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';

const {
  getAiConfig,
  initConfigStore,
  projectPublicAiConfig,
  updateApiKeysConfig,
} = await import('../vps-server/config-store.js');
const {
  buildAiChatRequest,
  buildAiCompletionsUrl,
} = await import('../vps-server/deepseek-engineer.js');

test('legacy riverConfig migrates into provider-aware configuration', async () => {
  const store = await initConfigStore();
  assert.equal(store.activeAiProvider, 'river');
  assert.equal(store.aiProviders.river.baseUrl, 'https://legacy-river.example');
  assert.equal(store.aiProviders.river.apiKey, 'legacy-river-secret-key');
  assert.equal(store.aiProviders.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(store.aiProviders.deepseek.model, 'deepseek-chat');
  assert.equal(store.keyVault[0].providerId, 'river');
});

test('public AI projection masks secrets for every provider', async () => {
  const projected = projectPublicAiConfig({
    activeAiProvider: 'deepseek',
    aiProviders: {
      river: { apiKey: 'river-secret-key', model: 'river-model' },
      deepseek: { apiKey: 'deepseek-secret-key', model: 'deepseek-chat' },
    },
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('river-secret-key'), false);
  assert.equal(serialized.includes('deepseek-secret-key'), false);
  assert.equal(projected.providers.river.maskedApiKey.length > 0, true);
  assert.equal(projected.providers.deepseek.maskedApiKey.length > 0, true);
});

test('active provider rejects unsupported values', async () => {
  await assert.rejects(
    updateApiKeysConfig({ activeAiProvider: 'unknown-provider' }),
    /Unsupported AI provider/
  );
});

test('River request includes River-only extensions', () => {
  const config = {
    baseUrl: 'https://api.river.ai',
    apiKey: 'river-key',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    stream: true,
    temperature: 0.7,
    maxTokens: 2048,
    chatTemplateKwargs: { enable_thinking: false },
  };
  const request = buildAiChatRequest('river', config, {
    messages: [{ role: 'user', content: 'hello' }],
    conversationId: 'conversation-id',
  });
  assert.equal(request.endpoint, 'https://api.river.ai/v1/chat/completions');
  assert.equal(request.headers['X-River-Conversation-Id'], 'conversation-id');
  assert.deepEqual(request.body.chat_template_kwargs, { enable_thinking: false });
});

test('official DeepSeek request omits River-only extensions', () => {
  const config = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'deepseek-key',
    model: 'deepseek-chat',
    stream: true,
    temperature: 0.7,
    maxTokens: 2048,
  };
  const request = buildAiChatRequest('deepseek', config, {
    messages: [{ role: 'user', content: 'hello' }],
    conversationId: 'conversation-id',
  });
  assert.equal(buildAiCompletionsUrl(config.baseUrl), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(request.headers['X-River-Conversation-Id'], undefined);
  assert.equal(request.body.chat_template_kwargs, undefined);
  assert.equal(request.body.model, 'deepseek-chat');
});

test('provider-aware config can select official DeepSeek', async () => {
  await updateApiKeysConfig({
    activeAiProvider: 'deepseek',
    aiProviders: {
      deepseek: {
        apiKey: 'new-deepseek-secret',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
      },
    },
  });
  const config = await getAiConfig();
  assert.equal(config.providerId, 'deepseek');
  assert.equal(config.apiKey, 'new-deepseek-secret');
  assert.equal(config.model, 'deepseek-chat');
});

test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});
