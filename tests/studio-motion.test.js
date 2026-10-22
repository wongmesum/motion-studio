import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectDraft, MOTION_PRESETS } from '../vps-server/studio/project-schema.js';
import { compileProject } from '../vps-server/studio/compile-project.js';
import { supportsProperty } from '../studio-assets/template-capabilities.js';

function project(motion, sceneDuration = 4) {
  return {
    schemaVersion: 1, title: 'Animation Test', template: 'base',
    render: { fps: 30, width: 1280, height: 720, codec: 'h264' },
    scenes: [{ durationSec: sceneDuration, elements: [
      { type: 'text', role: 'title', text: 'Halo', motion }
    ] }]
  };
}

test('approved motion presets survive project normalization', () => {
  for (const preset of MOTION_PRESETS) {
    const output = normalizeProjectDraft(project({ preset, startSec: 0.2, durationSec: 1 }));
    assert.deepEqual(output.scenes[0].elements[0].motion, { preset, startSec: 0.2, durationSec: 1 });
  }
});

test('old scene without motion remains compatible', () => {
  const output = normalizeProjectDraft(project(undefined));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.scenes[0].elements[0].motion, undefined);
});

test('rejects untrusted motion presets, timing, and extra keys', () => {
  for (const motion of [
    { preset: '<script>', startSec: 0, durationSec: 1 },
    { preset: 'fade-in', startSec: -1, durationSec: 1 },
    { preset: 'fade-in', startSec: 0, durationSec: 0 },
    { preset: 'fade-in', startSec: 2, durationSec: 3 },
    { preset: 'fade-in', startSec: Infinity, durationSec: 1 }
  ]) assert.throws(() => normalizeProjectDraft(project(motion)), /animasi/i);
  const clean = normalizeProjectDraft(project({ preset: 'zoom-in', startSec: 0, durationSec: 1, code: 'malicious' }));
  assert.equal('code' in clean.scenes[0].elements[0].motion, false);
});

test('motion data survives deterministic compile', async () => {
  const template = '<html><body><script>window.renderFrame=function(){};</script></body></html>';
  const output = await compileProject(project({ preset: 'slide-up', startSec: 0, durationSec: 1 }), {
    readTemplate: async () => template
  });
  assert.equal(output.project.scenes[0].elements[0].motion.preset, 'slide-up');
  assert.match(output.html, /slide-up/);
});


test('inspector advertises motion on every implemented text renderer and mixer media', () => {
  for (const template of ['base', 'kinetic-text', 'image-slideshow', 'video-mixer']) {
    assert.equal(supportsProperty(template, 'text', 'motion'), true);
  }
  for (const template of ['base', 'kinetic-text', 'image-slideshow']) {
    assert.equal(supportsProperty(template, 'image', 'motion'), false);
    assert.equal(supportsProperty(template, 'video', 'motion'), false);
  }
  assert.equal(supportsProperty('video-mixer', 'image', 'motion'), true);
  assert.equal(supportsProperty('video-mixer', 'video', 'motion'), true);
});

test('defaulted motion values must fit the scene and cannot bypass timing validation', () => {
  assert.throws(
    () => normalizeProjectDraft(project({ preset: 'fade-in', startSec: 0.4 }, 0.6)),
    /animasi/i
  );
  assert.deepEqual(
    normalizeProjectDraft(project({ preset: 'fade-in' }, 1)).scenes[0].elements[0].motion,
    { preset: 'fade-in', startSec: 0, durationSec: 0.8 }
  );
});
