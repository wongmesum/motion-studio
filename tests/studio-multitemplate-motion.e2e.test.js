import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { compileProject } from '../vps-server/studio/compile-project.js';

const TEMPLATES = ['kinetic-text', 'image-slideshow', 'video-mixer'];
const W = 1920;
const H = 1080;

function project(template, animated) {
  return {
    schemaVersion: 1, title: 'Cross-template motion', template,
    render: { fps: 30, width: W, height: H, codec: 'h264' },
    scenes: [{
      durationSec: 2,
      transition: { type: 'none', durationSec: 0 },
      elements: [
        {
          type: 'text', role: 'title', text: 'TITLE MOTION',
          ...(animated ? { motion: { preset: 'fade-in', startSec: 0, durationSec: 1.2 } } : {})
        },
        {
          type: 'text', role: 'subtitle', text: 'Subtitle test'
        }
      ]
    }]
  };
}

async function snapshot(browser, html, times) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => window.__ASSETS_READY__);
    const captures = [];
    for (const seconds of times) {
      await page.evaluate(t => window.renderFrame(t), seconds);
      captures.push(await page.screenshot({ type: 'png', animations: 'disabled' }));
    }
    return captures;
  } finally {
    await page.close();
  }
}

test('cross-template motion changes frames while preview and final render match', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const template of TEMPLATES) {
      const readTemplate = () => fs.readFile(path.resolve('render-engine/templates', template + '.html'), 'utf8');
      const [preview, render, staticResult] = await Promise.all([
        compileProject(project(template, true), { target: 'preview', readTemplate }),
        compileProject(project(template, true), { target: 'render', readTemplate }),
        compileProject(project(template, false), { target: 'render', readTemplate })
      ]);
      assert.match(preview.html, /id="motion-preset-runtime"/);
      assert.match(render.html, /id="motion-preset-runtime"/);
      assert.doesNotMatch(staticResult.html, /id="motion-preset-runtime"/);
      const [previewFrames, renderFrames, staticFrames] = await Promise.all([
        snapshot(browser, preview.html, [0.15, 1.6, 0.15]),
        snapshot(browser, render.html, [0.15, 1.6, 0.15]),
        snapshot(browser, staticResult.html, [0.15, 1.6])
      ]);
      assert.ok(previewFrames[0].equals(previewFrames[2]), template + ': non-deterministic replay');
      assert.ok(previewFrames[0].equals(renderFrames[0]), template + ': preview/render differ at entry');
      assert.ok(previewFrames[1].equals(renderFrames[1]), template + ': preview/render differ after motion');
      assert.ok(!renderFrames[0].equals(staticFrames[0]), template + ': motion has no visible effect');
      assert.ok(renderFrames[1].equals(staticFrames[1]), template + ': finished motion should be visually neutral');
    }
  } finally {
    await browser.close();
  }
});

test('video-mixer animates a media card without fetching external media URLs', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const readTemplate = () => fs.readFile(path.resolve('render-engine/templates/video-mixer.html'), 'utf8');
    const assetId = 'ast_11111111-1111-4111-8111-111111111111';
    const withCard = project('video-mixer', false);
    withCard.scenes[0].elements.push({
      type: 'image', role: 'pip', assetId, width: 0.3, x: 0.2, y: 0.25,
      motion: { preset: 'zoom-in', startSec: 0, durationSec: 1.2 }
    });
    const withoutMotion = structuredClone(withCard);
    delete withoutMotion.scenes[0].elements[2].motion;
    const options = {
      target: 'preview', readTemplate,
      buildPreviewUrl: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='
    };
    const [yes, no] = await Promise.all([
      compileProject(withCard, options), compileProject(withoutMotion, options)
    ]);
    const [animated, staticFrames] = await Promise.all([
      snapshot(browser, yes.html, [0.2, 1.6, 0.2]),
      snapshot(browser, no.html, [0.2, 1.6])
    ]);
    assert.ok(animated[0].equals(animated[2]), 'mixer PiP motion seek must be deterministic');
    assert.ok(!animated[0].equals(staticFrames[0]), 'PiP card does not animate');
    assert.ok(animated[1].equals(staticFrames[1]), 'PiP motion should settle to original size');
  } finally {
    await browser.close();
  }
});

test('SceneDirector tap/swipe overlay stays deterministic on all additional templates', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const template of TEMPLATES) {
      const data = project(template, true);
      data.scenes[0].gestures = [
        { type: 'swipe', effect: 'sunburst-soft', startSec: 0.1, durationSec: 1.2,
          from: { x: 0.25, y: 0.35 }, to: { x: 0.75, y: 0.55 } }
      ];
      const readTemplate = () => fs.readFile(path.resolve('render-engine/templates', template + '.html'), 'utf8');
      const [preview, render] = await Promise.all([
        compileProject(data, { target: 'preview', readTemplate }),
        compileProject(data, { target: 'render', readTemplate })
      ]);
      const output = [];
      for (const html of [preview.html, render.html]) {
        const page = await browser.newPage({ viewport: { width: W, height: H } });
        try {
          await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
          await page.setContent(html, { waitUntil: 'load' });
          const overlay = [];
          for (const time of [0.35, 1.0, 0.35]) {
            overlay.push(await page.evaluate(t => {
              window.renderFrame(t);
              const layer = document.getElementById('motion-gesture-layer');
              if (!layer) throw new Error('Missing gesture overlay');
              return layer.toDataURL('image/png');
            }, time));
          }
          assert.equal(overlay[0], overlay[2], template + ': overlay failed seek replay');
          assert.notEqual(overlay[0], overlay[1], template + ': gesture did not animate');
          output.push(overlay[1]);
        } finally {
          await page.close();
        }
      }
      assert.equal(output[0], output[1], template + ': overlay differs in preview and render');
    }
  } finally {
    await browser.close();
  }
});
