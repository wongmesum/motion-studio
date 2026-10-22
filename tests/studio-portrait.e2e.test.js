import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { compileProject } from '../vps-server/studio/compile-project.js';

const W = 1080, H = 1920;
function project(template) {
  return {
    schemaVersion: 1, title: 'Portrait stage', template,
    render: { fps: 8, width: W, height: H, codec: 'h264' },
    scenes: [{
      durationSec: 1, transition: { type: 'none', durationSec: 0 },
      elements: [{
        type: 'text', role: 'title', text: 'FULL TITLE VISIBLE',
        motion: { preset: 'fade-in', startSec: 0, durationSec: 0.5 }
      }],
      gestures: [{
        type: 'tap', effect: 'sunburst-soft', startSec: 0.1, durationSec: 0.8,
        from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 }
      }]
    }]
  };
}

test('portrait 9:16 contains the full landscape template stage with a full-height gesture layer', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const template of ['base', 'kinetic-text', 'image-slideshow', 'video-mixer']) {
      const readTemplate = () => fs.readFile(
        path.resolve('render-engine/templates', template + '.html'), 'utf8'
      );
      const compiled = await compileProject(project(template), { target: 'render', readTemplate });
      assert.match(compiled.html, /id="motion-viewport-fit"/);
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      try {
        await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
        await page.setContent(compiled.html, { waitUntil: 'load' });
        await page.evaluate(() => window.renderFrame(0.5));
        const geometry = await page.evaluate(() => {
          const stage = document.getElementById('motion-stage-fit');
          const layer = document.getElementById('motion-gesture-layer');
          if (!stage || !layer) return null;
          const rect = stage.getBoundingClientRect();
          return {
            stageX: rect.x, stageY: rect.y, stageW: rect.width, stageH: rect.height,
            layerW: layer.getBoundingClientRect().width,
            layerH: layer.getBoundingClientRect().height,
            scrollWidth: document.documentElement.scrollWidth
          };
        });
        assert.ok(geometry, template + ': missing fitted stage/gesture overlay');
        assert.ok(Math.abs(geometry.stageW - W) < 1, template + ': stage clipped');
        assert.ok(Math.abs(geometry.stageH - 607.5) < 1, template + ': stage aspect mismatch');
        assert.ok(Math.abs(geometry.stageY - (H - 607.5) / 2) < 1, template + ': not centered');
        assert.equal(geometry.layerW, W);
        assert.equal(geometry.layerH, H);
        assert.ok(geometry.scrollWidth <= W + 1, template + ': page overflows horizontally');
        if (process.env.MOTION_QA_OUTPUT_DIR) {
          const qaDir = path.resolve(process.env.MOTION_QA_OUTPUT_DIR);
          await fs.mkdir(qaDir, { recursive: true });
          await page.screenshot({ path: path.join(qaDir, template + '-portrait.png'),
            type: 'png', animations: 'disabled' });
        }
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('portrait base preview and export render the same frame pixels', async () => {
  const readTemplate = () => fs.readFile(path.resolve('render-engine/templates/base.html'), 'utf8');
  const [preview, render] = await Promise.all([
    compileProject(project('base'), { target: 'preview', readTemplate }),
    compileProject(project('base'), { target: 'render', readTemplate })
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const images = [];
    for (const html of [preview.html, render.html]) {
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      try {
        await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => window.renderFrame(0.6));
        images.push(await page.screenshot({ type: 'png', animations: 'disabled' }));
      } finally { await page.close(); }
    }
    assert.ok(images[0].equals(images[1]), 'portrait preview and export differ');
  } finally { await browser.close(); }
});
