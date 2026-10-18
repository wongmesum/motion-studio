import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_PROVIDER = 'deepseek';
process.env.RIVER_API_BASE_URL = 'https://api.river.ai';
process.env.RIVER_API_KEY = '';
process.env.RIVER_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash';
process.env.DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
// Intentionally empty: automated tests must never issue a live paid API call.
process.env.DEEPSEEK_API_KEY = '';
process.env.DEEPSEEK_MODEL = 'deepseek-chat';

const { buildProviderRequest, askDeepSeek } = await import('../mcp-server/tools/deepseek.js');

test('MCP selects the official DeepSeek provider from AI_PROVIDER', async () => {
  const result = await askDeepSeek({ goal: 'Deterministic title card' });
  assert.equal(result.mode, 'local_heuristic_fallback');
  assert.equal(result.providerId, 'deepseek');
  assert.equal(result.model, 'deepseek-chat');
  assert.match(result.html, /renderFrame/);
});

test('official DeepSeek request omits River-only header and body fields', () => {
  const config = {
    providerId: 'deepseek',
    apiKey: 'deepseek-test-key',
    model: 'deepseek-chat',
  };
  const request = buildProviderRequest(config, [{ role: 'user', content: 'hello' }], 'conversation-id');
  assert.equal(request.headers['X-River-Conversation-Id'], undefined);
  assert.equal(request.body.chat_template_kwargs, undefined);
  assert.equal(request.body.model, 'deepseek-chat');
  assert.equal(request.headers.Authorization, 'Bearer deepseek-test-key');
});

test('River request keeps conversation header and thinking flag', () => {
  const config = {
    providerId: 'river',
    apiKey: 'river-test-key',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  };
  const request = buildProviderRequest(config, [{ role: 'user', content: 'hello' }], 'conversation-id');
  assert.equal(request.headers['X-River-Conversation-Id'], 'conversation-id');
  assert.deepEqual(request.body.chat_template_kwargs, { enable_thinking: false });
});
