import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { compileProject } from '../vps-server/studio/compile-project.js';

// Frames must be the same whether requested from a preview or render document.
test('base motion preset is deterministic and preview matches render at identical timestamps', async () => {
  const project = {
    schemaVersion: 1, title: 'Motion visual smoke', template: 'base',
    render: { fps: 12, width: 1920, height: 1080, codec: 'h264' },
    scenes: [{ durationSec: 2, transition: { type: 'none', durationSec: 0 },
      elements: [{ type: 'text', role: 'title', text: 'MOTION TEST',
        motion: { preset: 'slide-up', startSec: 0, durationSec: 1.5 } }]
    }]
  };
  const readTemplate = () => fs.readFile(path.resolve('render-engine/templates/base.html'), 'utf8');
  const [{ html: previewHtml }, { html: renderHtml }] = await Promise.all([
    compileProject(project, { target: 'preview', readTemplate }),
    compileProject(project, { target: 'render', readTemplate })
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const captures = [];
    for (const html of [previewHtml, renderHtml]) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      try {
        // Avoid relying on a public CDN in CI; the template has a local fallback.
        await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
        await page.setContent(html, { waitUntil: 'load' });
        assert.equal(await page.evaluate(() => typeof window.renderFrame), 'function');
        const frames = [];
        for (const t of [0.1, 1.6, 0.1]) {
          await page.evaluate(time => window.renderFrame(time), t);
          frames.push(await page.screenshot({ type: 'png', animations: 'disabled' }));
        }
        assert.ok(frames[0].equals(frames[2]), 'repeated timestamp rendered different pixels');
        assert.ok(!frames[0].equals(frames[1]), 'animation did not change between timestamps');
        captures.push(frames[1]);
      } finally {
        await page.close();
      }
    }
    assert.ok(captures[0].equals(captures[1]), 'preview and render did not match at same frame');
  } finally {
    await browser.close();
  }
});
