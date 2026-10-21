import test from 'node:test';
import assert from 'node:assert/strict';
import {
  importProjectFile,
  parseProjectJson,
  serializeProject,
} from '../studio-assets/project-io.js';

function project(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'prj_11111111-1111-4111-8111-111111111111',
    title: 'Promo Kopi',
    template: 'base',
    render: { duration: 4, fps: 30, width: 1280, height: 720, codec: 'h264' },
    theme: { backgroundColor: '#070913' },
    audio: { assetId: 'ast_22222222-2222-4222-8222-222222222222' },
    scenes: [{
      id: 'scn_33333333-3333-4333-8333-333333333333',
      durationSec: 4,
      transition: { type: 'fade', durationSec: 0.5 },
      elements: [{
        id: 'el_44444444-4444-4444-8444-444444444444',
        type: 'image',
        role: 'background',
        assetId: 'ast_55555555-5555-4555-8555-555555555555',
      }],
    }],
    ...overrides,
  };
}

test('exported JSON is browser safe and keeps only opaque asset ids', () => {
  const source = project();
  source.localPath = 'C:\\renders\\promo.mp4';
  source.scenes[0].elements[0].src = 'file:///srv/assets/kopi.png';

  const serialized = serializeProject(source);

  for (const forbidden of ['localPath', 'file://', 'C:\\', '"src"']) {
    assert.equal(serialized.includes(forbidden), false, `export leaked ${forbidden}`);
  }
  assert.match(serialized, /ast_22222222-2222-4222-8222-222222222222/);
  assert.equal(JSON.parse(serialized).scenes[0].elements[0].src, undefined);
});

test('serialization fails closed when a filesystem path survives sanitizing', () => {
  const source = project({ title: 'C:\\projects\\promo' });
  assert.throws(() => serializeProject(source), /path lokal/);
});

test('import strips the project id before asking the server to validate', async () => {
  let received = null;
  const validated = await importProjectFile(
    {
      text: async () => JSON.stringify(project()),
    },
    async (draft) => {
      received = draft;
      return { project: { ...draft, projectId: 'prj_new' } };
    }
  );

  assert.equal(received.projectId, undefined);
  assert.equal(validated.projectId, undefined);
  assert.equal(validated.scenes.length, 1);
});

test('malformed JSON and non-object documents are rejected with Indonesian messages', () => {
  assert.throws(() => parseProjectJson('{nope'), /bukan JSON/);
  assert.throws(() => parseProjectJson('[]'), /berupa objek JSON/);
});
