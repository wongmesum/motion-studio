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
