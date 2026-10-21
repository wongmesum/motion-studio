import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_LIMITS,
  PROJECT_SCHEMA_VERSION,
  assertProjectForRender,
  normalizeProjectDraft,
} from '../vps-server/studio/project-schema.js';

function createValidProject(overrides = {}) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: 'prj_11111111-1111-4111-8111-111111111111',
    title: 'Promo Kopi Nusantara',
    template: 'image-slideshow',
    render: { duration: 12, fps: 30, width: 1280, height: 720, codec: 'h264' },
    theme: {
      backgroundColor: '#070913',
      primaryColor: '#38bdf8',
      accentColor: '#a855f7',
      fontFamily: 'Inter',
    },
    scenes: [
      {
        id: 'scn_22222222-2222-4222-8222-222222222222',
        durationSec: 4,
        transition: { type: 'fade', durationSec: 0.5 },
        elements: [
          {
            id: 'el_33333333-3333-4333-8333-333333333333',
            type: 'text',
            role: 'title',
            text: 'Kopi Nusantara',
            x: 0.08,
            y: 0.42,
            width: 0.84,
            fontSize: 96,
            color: '#f1f5f9',
            align: 'left',
          },
          {
            id: 'el_44444444-4444-4444-8444-444444444444',
            type: 'image',
            role: 'background',
            assetId: 'ast_55555555-5555-4555-8555-555555555555',
            fit: 'cover',
            kenBurns: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

test('a valid project normalizes and keeps its rendered settings', () => {
  const project = normalizeProjectDraft(createValidProject());

  assert.equal(project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(project.template, 'image-slideshow');
  assert.deepEqual(project.render, {
    duration: 4,
    fps: 30,
    width: 1280,
    height: 720,
    codec: 'h264',
  });
  assert.equal(project.scenes.length, 1);
  assert.equal(project.scenes[0].elements.length, 2);
  assert.equal(project.scenes[0].elements[0].text, 'Kopi Nusantara');
  assert.equal(project.scenes[0].elements[1].assetId, 'ast_55555555-5555-4555-8555-555555555555');
});

test('render duration is derived from scene durations and ignores client input', () => {
  const project = normalizeProjectDraft(createValidProject({
    render: { duration: 99, fps: 30, width: 1280, height: 720, codec: 'h264' },
    scenes: [
      { durationSec: 2.5, elements: [] },
      { durationSec: 7, elements: [] },
    ],
  }));

  assert.equal(project.render.duration, 9.5);
});

test('total scene duration cannot exceed the render job limit', () => {
  const project = createValidProject({
    scenes: [
      { durationSec: 40, elements: [] },
      { durationSec: 21, elements: [] },
    ],
  });

  assert.throws(
    () => normalizeProjectDraft(project),
    /Total durasi scene melebihi batas 60 detik/
  );
});

test('missing optional fields receive documented defaults', () => {
  const project = normalizeProjectDraft({
    template: 'base',
    scenes: [{ elements: [{ type: 'text', text: 'Halo' }] }],
  });

  assert.equal(project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(project.title, 'Untitled project');
  assert.equal(project.render.codec, 'h264');
  assert.equal(project.scenes[0].transition.type, 'fade');
  assert.equal(project.scenes[0].elements[0].role, 'title');
  assert.equal(project.scenes[0].elements[0].align, 'left');
  assert.equal(project.scenes[0].elements[0].x, 0.08);
  assert.match(project.scenes[0].elements[0].id, /^el_/);
  assert.match(project.scenes[0].id, /^scn_/);
  assert.match(project.projectId, /^prj_/);
});

test('unknown fields are dropped instead of carried into the template', () => {
  const dirty = createValidProject({
    injected: '<script>alert(1)</script>',
    render: { duration: 12, fps: 30, width: 1280, height: 720, codec: 'h264', extra: 'x' },
  });
  dirty.scenes[0].elements[0].onclick = 'alert(1)';

  const project = normalizeProjectDraft(dirty);

  assert.equal('injected' in project, false);
  assert.equal('extra' in project.render, false);
  assert.equal('onclick' in project.scenes[0].elements[0], false);
});

test('scene and element counts are bounded', () => {
  const manyScenes = createValidProject({
    scenes: Array.from({ length: PROJECT_LIMITS.maxScenes + 1 }, () => ({ elements: [] })),
  });
  assert.throws(() => normalizeProjectDraft(manyScenes), /scene/i);

  const manyElements = createValidProject({
    scenes: [
      {
        elements: Array.from({ length: PROJECT_LIMITS.maxElementsPerScene + 1 }, () => ({
          type: 'text',
          text: 'x',
        })),
      },
    ],
  });
  assert.throws(() => normalizeProjectDraft(manyElements), /elemen|element/i);
});

test('text length is bounded per element and per project', () => {
  const longText = createValidProject({
    scenes: [{ elements: [{ type: 'text', text: 'a'.repeat(PROJECT_LIMITS.maxTextChars + 1) }] }],
  });
  assert.throws(() => normalizeProjectDraft(longText), /teks|text/i);

  const manyLongTexts = createValidProject({
    scenes: Array.from({ length: 3 }, () => ({
      elements: Array.from({ length: PROJECT_LIMITS.maxElementsPerScene }, () => ({
        type: 'text',
        text: 'a'.repeat(PROJECT_LIMITS.maxTextChars),
      })),
    })),
  });
  assert.throws(() => normalizeProjectDraft(manyLongTexts), /teks|text/i);
});

test('title length is bounded', () => {
  const project = createValidProject({ title: 'a'.repeat(PROJECT_LIMITS.maxTitleChars + 1) });
  assert.throws(() => normalizeProjectDraft(project), /judul|title/i);
});

test('colors must be six digit hex values', () => {
  for (const color of ['red', '#fff', '#12345g', 'rgb(1,2,3)', 'url(x)']) {
    const project = createValidProject({
      scenes: [{ elements: [{ type: 'text', text: 'x', color }] }],
    });
    assert.throws(() => normalizeProjectDraft(project), /warna|color/i, `accepted ${color}`);
  }
});

test('roles, transitions, alignment and fit use closed sets', () => {
  const badRole = createValidProject({
    scenes: [{ elements: [{ type: 'text', text: 'x', role: 'overlay' }] }],
  });
  assert.throws(() => normalizeProjectDraft(badRole), /role/i);

  const badTransition = createValidProject({
    scenes: [{ transition: { type: 'wipe' }, elements: [] }],
  });
  assert.throws(() => normalizeProjectDraft(badTransition), /transisi|transition/i);

  const badAlign = createValidProject({
    scenes: [{ elements: [{ type: 'text', text: 'x', align: 'justify' }] }],
  });
  assert.throws(() => normalizeProjectDraft(badAlign), /align/i);

  const badFit = createValidProject({
    scenes: [
      {
        elements: [
          { type: 'image', assetId: 'ast_55555555-5555-4555-8555-555555555555', fit: 'fill' },
        ],
      },
    ],
  });
  assert.throws(() => normalizeProjectDraft(badFit), /fit/i);
});

test('positions and sizes stay inside the normalized 0..1 range', () => {
  for (const x of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    const project = createValidProject({
      scenes: [{ elements: [{ type: 'text', text: 'x', x }] }],
    });
    assert.throws(() => normalizeProjectDraft(project), /posisi|x/i, `accepted x=${x}`);
  }
});

test('font size must be an integer inside the allowed range', () => {
  for (const fontSize of [11, 241, 48.5, 'big']) {
    const project = createValidProject({
      scenes: [{ elements: [{ type: 'text', text: 'x', fontSize }] }],
    });
    assert.throws(() => normalizeProjectDraft(project), /font/i, `accepted ${fontSize}`);
  }
});

test('asset ids must use the opaque generated form', () => {
  for (const assetId of ['../../etc/passwd', 'file:///etc/passwd', 'ast_../x', '', 'ast_ZZZ']) {
    const project = createValidProject({
      scenes: [{ elements: [{ type: 'image', assetId }] }],
    });
    assert.throws(() => normalizeProjectDraft(project), /aset|asset/i, `accepted ${assetId}`);
  }
});

test('template names must be safe ids', () => {
  for (const template of ['../server', 'Base', 'base.html', '', '<script>']) {
    const project = createValidProject({ template });
    assert.throws(() => normalizeProjectDraft(project), /template/i, `accepted ${template}`);
  }
});

test('unknown element types are rejected', () => {
  const project = createValidProject({
    scenes: [{ elements: [{ type: 'iframe', text: 'x' }] }],
  });
  assert.throws(() => normalizeProjectDraft(project), /tipe|type/i);
});

test('assertProjectForRender enforces the existing render limits', () => {
  const tooLong = createValidProject({
    render: { duration: 61, fps: 30, width: 1280, height: 720, codec: 'h264' },
    scenes: [{ durationSec: 61, elements: [] }],
  });
  assert.throws(() => assertProjectForRender(tooLong), /durasi scene/i);

  const badCodec = createValidProject({
    render: { duration: 10, fps: 30, width: 1280, height: 720, codec: 'mpeg2' },
  });
  assert.throws(() => assertProjectForRender(badCodec), /Codec/i);

  assert.equal(assertProjectForRender(createValidProject()).template, 'image-slideshow');
});

test('project audio normalizes to a single opaque asset id or null', () => {
  const withAudio = normalizeProjectDraft(createValidProject({
    audio: { assetId: 'ast_66666666-6666-4666-8666-666666666666' },
  }));
  assert.deepEqual(withAudio.audio, { assetId: 'ast_66666666-6666-4666-8666-666666666666' });

  const withoutAudio = normalizeProjectDraft(createValidProject());
  assert.equal(withoutAudio.audio, null);
});

test('project audio rejects non-opaque asset ids and dropped foreign fields', () => {
  for (const assetId of ['../../etc/passwd', 'file:///tmp/x.mp3', 'ast_../x', '']) {
    assert.throws(
      () => normalizeProjectDraft(createValidProject({ audio: { assetId } })),
      /aset|audio/i,
      `accepted ${assetId}`
    );
  }

  const dirty = normalizeProjectDraft(createValidProject({
    audio: { assetId: 'ast_66666666-6666-4666-8666-666666666666', volume: 0.8, localPath: '/x' },
  }));
  assert.deepEqual(dirty.audio, { assetId: 'ast_66666666-6666-4666-8666-666666666666' });
});

test('normalization never mutates the caller input', () => {
  const input = createValidProject();
  const snapshot = structuredClone(input);
  normalizeProjectDraft(input);
  assert.deepEqual(input, snapshot);
});
