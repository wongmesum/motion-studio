import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { normalizeProjectDraft } from '../vps-server/studio/project-schema.js';
import { compileProject } from '../vps-server/studio/compile-project.js';

const keyframes = [
  { timeSec: 0, x: -120, y: 65, scale: 0.8, opacity: 0 },
  { timeSec: 0.5, x: 0, y: 10, scale: 0.95, opacity: 0.6 },
  { timeSec: 1, x: 20, y: 0, scale: 1, opacity: 1 },
];

function draft(template = 'base', motion = { preset: 'none', startSec: 0, durationSec: 1, keyframes }) {
  return {
    schemaVersion: 1, title: 'Keyframe Motion', template,
    render: { fps: 12, width: 1920, height: 1080, codec: 'h264' },
    scenes: [{ durationSec: 2, transition: { type: 'none', durationSec: 0 },
      elements: [{ type: 'text', role: 'title', text: 'Keyframe test', motion }]
    }]
  };
}

test('schema v1 supports bounded, sorted keyframes without extra keys', () => {
  const value = draft();
  value.scenes[0].elements[0].motion.keyframes[0].unsafe = '<script>';
  const result = normalizeProjectDraft(value);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.scenes[0].elements[0].motion.keyframes[0], keyframes[0]);
  assert.equal(result.scenes[0].elements[0].motion.preset, 'none');
});

test('keyframes reject malformed, unsafe or ill-ordered paths', () => {
  for (const frames of [
    [], [keyframes[0]], Array.from({ length: 9 }, (_, i) => ({ ...keyframes[0], timeSec: i / 10 })),
    [keyframes[1], keyframes[0]], [keyframes[0], keyframes[0]],
    [{ ...keyframes[0], x: 700 }, keyframes[2]],
    [{ ...keyframes[0], opacity: NaN }, keyframes[2]],
    [{ ...keyframes[0], scale: 0 }, keyframes[2]],
    [keyframes[0], { ...keyframes[2], timeSec: 1.5 }]
  ]) {
    assert.throws(() => normalizeProjectDraft(draft('base', {
      preset: 'none', startSec: 0, durationSec: 1, keyframes: frames
    })), /keyframe/i);
  }
  assert.throws(() => normalizeProjectDraft(draft('base', {
    preset: 'none', startSec: 1.5, durationSec: 1, keyframes
  })), /animasi/i);
});

test('keyframe evaluator interpolates and is independent from frame order', async () => {
  const readTemplate = () => fs.readFile(path.resolve('render-engine/templates/base.html'), 'utf8');
  const [preview, render] = await Promise.all([
    compileProject(draft(), { target: 'preview', readTemplate }),
    compileProject(draft(), { target: 'render', readTemplate })
  ]);
  assert.match(render.html, /id="motion-preset-runtime"/);
  const browser = await chromium.launch({ headless: true });
  try {
    const observed = [];
    for (const { html } of [preview, render]) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      try {
        await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
        await page.setContent(html, { waitUntil: 'load' });
        observed.push(await page.evaluate(() => {
          const motion = JSON.parse(document.querySelector('#motion-project-data').textContent)
            .scenes[0].elements[0].motion;
          const engine = window.MotionStudioMotion;
          const t0 = engine.evaluate(motion, 0);
          const t025 = engine.evaluate(motion, 0.25);
          const t075 = engine.evaluate(motion, 0.75);
          const t1 = engine.evaluate(motion, 1);
          window.renderFrame(0.25);
          const first = document.getElementById('title').style.transform;
          window.renderFrame(0.75);
          window.renderFrame(0.25);
          assertWindowEqual(document.getElementById('title').style.transform, first);
          function assertWindowEqual(actual, expected) {
            if (actual !== expected) throw new Error('Frame seek not deterministic');
          }
          return { t0, t025, t075, t1 };
        }));
      } finally { await page.close(); }
    }
    assert.deepEqual(observed[0], observed[1]);
    assert.equal(observed[0].t0.opacity, 0);
    assert.equal(observed[0].t025.opacity, 0.3);
    assert.equal(observed[0].t075.opacity, 0.8);
    assert.equal(observed[0].t1.offsetX, 20);
  } finally { await browser.close(); }
});
