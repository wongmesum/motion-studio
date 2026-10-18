import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAiTestInput } from '../vps-server/security/ai-test-input.js';

test('AI test input accepts a bounded provider request', () => {
  assert.deepEqual(
    validateAiTestInput({
      providerId: 'deepseek',
      prompt: 'hello',
      conversationId: '70fd1aee-1f58-444a-94a7-adcb41c33549',
      temperature: 0.4,
      maxTokens: 512,
      stream: false,
      enableThinking: false,
    }),
    {
      providerId: 'deepseek',
      prompt: 'hello',
      conversationId: '70fd1aee-1f58-444a-94a7-adcb41c33549',
      temperature: 0.4,
      maxTokens: 512,
      stream: false,
      enableThinking: false,
    }
  );
});

test('AI test input rejects missing, blank, and oversized prompts', () => {
  assert.throws(() => validateAiTestInput({}), /Prompt wajib diisi/);
  assert.throws(() => validateAiTestInput({ prompt: '   ' }), /Prompt wajib diisi/);
  assert.throws(() => validateAiTestInput({ prompt: 'x'.repeat(10001) }), /maksimum 10000/);
});

test('AI test input rejects invalid numeric and boolean controls', () => {
  assert.throws(() => validateAiTestInput({ prompt: 'x', temperature: '0.5' }), /temperature/);
  assert.throws(() => validateAiTestInput({ prompt: 'x', temperature: 3 }), /temperature/);
  assert.throws(() => validateAiTestInput({ prompt: 'x', maxTokens: 1.5 }), /maxTokens/);
  assert.throws(() => validateAiTestInput({ prompt: 'x', maxTokens: 40000 }), /maxTokens/);
  assert.throws(() => validateAiTestInput({ prompt: 'x', stream: 'false' }), /stream/);
  assert.throws(() => validateAiTestInput({ prompt: 'x', enableThinking: 1 }), /enableThinking/);
});

test('AI test input rejects invalid providers, UUIDs, and unknown fields', () => {
  assert.throws(() => validateAiTestInput({ prompt: 'x', providerId: 'other' }), /Provider AI/);
  assert.throws(() => validateAiTestInput({ prompt: 'x', conversationId: 'bad' }), /conversationId/);
  assert.throws(() => validateAiTestInput({ prompt: 'x', apiKey: 'override' }), /Field tidak didukung/);
});

test('River alias rejects a contradictory provider', () => {
  assert.throws(
    () => validateAiTestInput({ prompt: 'x', providerId: 'deepseek' }, 'river'),
    /harus menggunakan provider river/
  );
  const validated = validateAiTestInput({ prompt: 'x' }, 'river');
  assert.equal(validated.providerId, 'river');
});
