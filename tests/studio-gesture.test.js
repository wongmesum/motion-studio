import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { normalizeProjectDraft } from '../vps-server/studio/project-schema.js';
import { compileProject } from '../vps-server/studio/compile-project.js';

const tap = () => ({
  type: 'tap', effect: 'sunburst', startSec: 0,
  durationSec: 1, from: { x: 0.3, y: 0.4 },
  to: { x: 0.3, y: 0.4 }
});
function project(gesture = tap()) {
  return {
    schemaVersion: 1, title: 'Gesture editor test', template: 'base',
    render: { fps: 10, width: 1920, height: 1080, codec: 'h264' },
    scenes: [{ durationSec: 2, transition: { type: 'none', durationSec: 0 },
      elements: [{ type: 'text', role: 'title', text: 'Gesture Demo' }],
      gestures: [gesture] }]
  };
}
const readTemplate = () => fs.readFile(path.resolve('render-engine/templates/base.html'), 'utf8');

test('scene gestures normalize and discard extra fields', () => {
  const data = project();
  data.scenes[0].gestures[0].unsafe = '<script>';
  const output = normalizeProjectDraft(data);
  assert.deepEqual(output.scenes[0].gestures[0], tap());
  assert.equal(normalizeProjectDraft({
    title: 'Legacy', template: 'base', scenes: [{ elements: [] }]
  }).scenes[0].gestures, undefined);
});
test('rejects out-of-bounds, unknown, and over-limit gesture instructions', () => {
  const bad = [
    { ...tap(), from: { x: 1.5, y: 0.4 } },
    { ...tap(), type: 'execute-js' },
    { ...tap(), effect: 'https://evil.invalid/file' },
    { ...tap(), startSec: 1.5, durationSec: 1 },
    { ...tap(), startSec: NaN },
    { ...tap(), durationSec: 0 }
  ];
  for (const gesture of bad) {
    assert.throws(() => normalizeProjectDraft(project(gesture)), /gesture|posisi|timing/i);
  }
  const value = project();
  value.scenes[0].gestures = Array.from({ length: 7 }, tap);
  assert.throws(() => normalizeProjectDraft(value), /gesture/i);
});
test('same gesture frame stays identical between preview and render; no asset CDN', async () => {
  const results = await Promise.all([
    compileProject(project(), { target: 'preview', readTemplate }),
    compileProject(project(), { target: 'render', readTemplate })
  ]);
  for (const { html } of results) {
    assert.match(html, /motion-gesture-runtime/);
    assert.match(html, /motion-gesture-art/);
    assert.ok(!html.includes('https://evil.invalid/'));
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const parity = [];
    for (const { html } of results) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      try {
        await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
        await page.setContent(html, { waitUntil: 'load' });
        const drawings = [];
        for (const seconds of [0.2, 0.7, 0.2]) {
          drawings.push(await page.evaluate(t => {
            window.renderFrame(t);
            const canvas = document.getElementById('motion-gesture-layer');
            if (!canvas) throw new Error('gesture overlay missing');
            return canvas.toDataURL('image/png');
          }, seconds));
        }
        assert.equal(drawings[0], drawings[2]);
        assert.notEqual(drawings[0], drawings[1]);
        parity.push(drawings[1]);
      } finally {
        await page.close();
      }
    }
    assert.equal(parity[0], parity[1]);
  } finally { await browser.close(); }
});

test('soft eight-ray Lottie effect is allowlisted and renders distinct offline artwork', async () => {
  const soft = project({ ...tap(), effect: 'sunburst-soft' });
  const classic = project(tap());
  assert.equal(normalizeProjectDraft(soft).scenes[0].gestures[0].effect, 'sunburst-soft');
  const [softPreview, softRender, classicRender] = await Promise.all([
    compileProject(soft, { target: 'preview', readTemplate }),
    compileProject(soft, { target: 'render', readTemplate }),
    compileProject(classic, { target: 'render', readTemplate })
  ]);
  assert.match(softRender.html, /burstSoft/);
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const html of [softPreview.html, softRender.html, classicRender.html]) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      try {
        await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
        await page.setContent(html, { waitUntil: 'load' });
        results.push(await page.evaluate(() => {
          window.renderFrame(0.7);
          return document.getElementById('motion-gesture-layer').toDataURL('image/png');
        }));
      } finally { await page.close(); }
    }
    assert.equal(results[0], results[1], 'soft Lottie preview and render are different');
    assert.notEqual(results[1], results[2], 'soft Lottie artwork matches classic unexpectedly');
  } finally {
    await browser.close();
  }
});

test('swipe keyframes normalize in time order and drop unsafe fields', () => {
  const gesture = {
    ...tap(), type: 'swipe', effect: 'sunburst-star', easing: 'ease-in-out',
    from: { x: 0.1, y: 0.5 }, to: { x: 0.9, y: 0.5 },
    keyframes: [{ at: 0.35, x: 0.4, y: 0.2, script: 'unsafe' },
      { at: 0.7, x: 0.6, y: 0.8 }]
  };
  const normalized = normalizeProjectDraft(project(gesture)).scenes[0].gestures[0];
  assert.equal(normalized.effect, 'sunburst-star');
  assert.equal(normalized.easing, 'ease-in-out');
  assert.deepEqual(normalized.keyframes, [
    { at: 0.35, x: 0.4, y: 0.2 }, { at: 0.7, x: 0.6, y: 0.8 }
  ]);
  assert.equal('script' in normalized.keyframes[0], false);
});

test('reject invalid gesture keyframes, easing, times and coordinates', () => {
  const base = { ...tap(), type: 'swipe' };
  for (const patch of [
    { easing: 'eval()' },
    { keyframes: [null] },
    { keyframes: [{ at: 0.5, y: 0.3 }] },
    { keyframes: [{ at: 0.5, x: 0.3, y: Number.NaN }] },
    { keyframes: [{ at: 0, x: 0.3, y: 0.4 }] },
    { keyframes: [{ at: 1, x: 0.3, y: 0.4 }] },
    { keyframes: [{ at: 0.6, x: 0.3, y: 0.4 },
      { at: 0.4, x: 0.3, y: 0.4 }] },
    { keyframes: Array.from({ length: 5 }, (_, i) => ({ at: (i + 1) / 6, x: 0.5, y: 0.5 })) }
  ]) {
    assert.throws(() => normalizeProjectDraft(project({ ...base, ...patch })),
      /keyframe|gesture|easing|posisi/i);
  }
  assert.throws(() => normalizeProjectDraft(project({
    ...tap(), keyframes: [{ at: 0.5, x: 0.4, y: 0.5 }]
  })), /keyframe|gesture/i);
});

test('intermediate swipe keyframes move the cursor and keep preview/render parity', async () => {
  const keyframed = project({
    type: 'swipe', effect: 'none', startSec: 0, durationSec: 1.5,
    from: { x: 0.15, y: 0.5 }, to: { x: 0.85, y: 0.5 },
    easing: 'linear', keyframes: [{ at: 0.5, x: 0.5, y: 0.15 }]
  });
  const straight = structuredClone(keyframed);
  delete straight.scenes[0].gestures[0].keyframes;
  const [preview, render, straightOutput] = await Promise.all([
    compileProject(keyframed, { target: 'preview', readTemplate }),
    compileProject(keyframed, { target: 'render', readTemplate }),
    compileProject(straight, { target: 'render', readTemplate })
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const frames = [];
    for (const html of [preview.html, render.html, straightOutput.html]) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      try {
        await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
        await page.setContent(html, { waitUntil: 'load' });
        frames.push(await page.evaluate(() => {
          window.renderFrame(0.75);
          return document.getElementById('motion-gesture-layer').toDataURL('image/png');
        }));
      } finally { await page.close(); }
    }
    assert.equal(frames[0], frames[1], 'preview/render keyframe path differs');
    assert.notEqual(frames[1], frames[2], 'intermediate keyframe was ignored');
  } finally { await browser.close(); }
});

test('new wide and star Lottie variants render different geometry', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const frames = [];
    for (const effect of ['sunburst', 'sunburst-wide', 'sunburst-star']) {
      const { html } = await compileProject(project({ ...tap(), effect }), {
        target: 'render', readTemplate
      });
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      try {
        await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
        await page.setContent(html, { waitUntil: 'load' });
        frames.push(await page.evaluate(() => {
          window.renderFrame(0.7);
          return document.getElementById('motion-gesture-layer').toDataURL('image/png');
        }));
      } finally { await page.close(); }
    }
    assert.notEqual(frames[0], frames[1]);
    assert.notEqual(frames[0], frames[2]);
    assert.notEqual(frames[1], frames[2]);
  } finally { await browser.close(); }
});
