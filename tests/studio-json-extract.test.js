import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject } from '../vps-server/studio/json-extract.js';

test('plain JSON objects parse', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('  {"a":1}  '), { a: 1 });
});

test('markdown fenced JSON parses', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('```JSON\n{"a":1}\n```'), { a: 1 });
});

test('surrounding prose around a JSON object parses', () => {
  assert.deepEqual(
    extractJsonObject('Here is the scene structure:\n{"a":1}\nLet me know if you need changes.'),
    { a: 1 }
  );
});

test('already parsed objects pass through', () => {
  const value = { a: 1 };
  assert.equal(extractJsonObject(value), value);
});

test('empty or missing responses are rejected', () => {
  for (const input of ['', null, undefined]) {
    assert.throws(() => extractJsonObject(input), /kosong|empty/i, `accepted ${String(input)}`);
  }
});

test('responses without a JSON object are rejected with a bounded excerpt', () => {
  assert.throws(
    () => extractJsonObject('I cannot help with that request.'),
    (error) => {
      assert.match(error.message, /JSON/i);
      assert.ok(error.message.length < 400);
      return true;
    }
  );
});

test('malformed JSON inside braces still fails loudly', () => {
  assert.throws(() => extractJsonObject('{ "a": }'), /JSON/i);
});

test('nested objects survive extraction', () => {
  const nested = '{"scenes":[{"elements":[{"type":"text","text":"Halo"}]}]}';
  assert.deepEqual(extractJsonObject(nested), {
    scenes: [{ elements: [{ type: 'text', text: 'Halo' }] }],
  });
});
