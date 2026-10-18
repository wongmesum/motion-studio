import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-ai-transport-test-'));
process.env.MOTION_DATA_DIR = dataDir;
process.env.AI_PROVIDER = 'river';
process.env.RIVER_API_KEY = 'test-river-key';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
process.env.VPS_TOKEN = 'transport-test-vps-secret-value';
process.env.ADMIN_TOKEN = 'transport-test-admin-secret-value';
process.env.HMAC_SECRET = 'transport-test-hmac-secret-value';

const { callAiChat } = await import('../vps-server/deepseek-engineer.js');

function createTransport(data) {
  const calls = [];
  return {
    calls,
    post: async (...args) => {
      calls.push(args);
      return { data };
    },
  };
}

test('River transport receives River-only extensions and parses SSE', async () => {
  const transport = createTransport([
    'data: {"choices":[{"delta":{"content":"river "}}]}',
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: [DONE]',
  ].join('\n'));

  const result = await callAiChat({
    providerId: 'river',
    messages: [{ role: 'user', content: 'test' }],
    conversationId: '70fd1aee-1f58-444a-94a7-adcb41c33549',
    transport,
  });

  assert.equal(result.content, 'river ok');
  assert.equal(transport.calls.length, 1);
  const [endpoint, body, options] = transport.calls[0];
  assert.equal(endpoint, 'https://api.river.ai/v1/chat/completions');
  assert.equal(options.headers['X-River-Conversation-Id'], '70fd1aee-1f58-444a-94a7-adcb41c33549');
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test('DeepSeek transport omits River-only extensions and parses JSON', async () => {
  const transport = createTransport({
    choices: [{ message: { content: 'deepseek ok' } }],
  });

  const result = await callAiChat({
    providerId: 'deepseek',
    messages: [{ role: 'user', content: 'test' }],
    stream: false,
    transport,
  });

  assert.equal(result.content, 'deepseek ok');
  assert.equal(transport.calls.length, 1);
  const [endpoint, body, options] = transport.calls[0];
  assert.equal(endpoint, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(options.headers['X-River-Conversation-Id'], undefined);
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.model, 'deepseek-chat');
});

test('provider transport failures never invoke another provider', async () => {
  const calls = [];
  const transport = {
    post: async (endpoint) => {
      calls.push(endpoint);
      throw new Error('provider unavailable');
    },
  };

  await assert.rejects(
    callAiChat({
      providerId: 'river',
      messages: [{ role: 'user', content: 'test' }],
      transport,
    }),
    /provider unavailable/
  );

  assert.deepEqual(calls, ['https://api.river.ai/v1/chat/completions']);
});

test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});
