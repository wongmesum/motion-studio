import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { compileProject } from '../vps-server/studio/compile-project.js';

const read = file => fs.readFile(new URL('../' + file, import.meta.url), 'utf8');
const project = (type = 'tap', width = 1920, height = 1080) => ({
  schemaVersion: 1, title: 'Gesture regression', template: 'base',
  render: { fps: 30, width, height, codec: 'h264' },
  scenes: [{ durationSec: 2, elements: [], gestures: [{
    type, effect: 'sunburst', startSec: 0, durationSec: 1,
    from: { x: 0.3, y: 0.4 }, to: { x: 0.7, y: 0.6 }
  }] }]
});
const template = '<html><body><script>window.renderFrame=function(){};</script></body></html>';
const dataBlock = (html, id) => {
  const match = html.match(new RegExp('<script type="application/json" id="' + id + '">([\\s\\S]*?)</script>'));
  assert.ok(match, id + ' missing');
  return JSON.parse(match[1]);
};

test('artwork HTML retains the full upstream MIT notice in preview, render and AI output', async () => {
  const license = await read('third-party/claude-remotion-editor/LICENSE');
  assert.equal(license, await read('modules/lottie/UPSTREAM-LICENSE'));
  assert.match(license, /Copyright \(c\) 2026 ytrofr/);
  for (const target of ['preview', 'render']) {
    for (const useAiHtml of [false, true]) {
      const { html, warnings } = await compileProject(project(), {
        target, useAiHtml, readTemplate: async () => template,
        generateAiHtml: async () => template,
        testAiHtml: async () => ({ success: true })
      });
      assert.deepEqual(warnings, []);
      assert.equal(dataBlock(html, 'motion-gesture-license').license, license);
      assert.equal(dataBlock(html, 'motion-gesture-license').source,
        'https://github.com/ytrofr/claude-remotion-editor');
      assert.ok(dataBlock(html, 'motion-gesture-art').cursor.layers.length);
    }
  }
  const plain = project();
  delete plain.scenes[0].gestures;
  const { html } = await compileProject(plain, { readTemplate: async () => template });
  assert.ok(!html.includes('motion-gesture-license'));
});

test('all bundled artwork and upstream notices match the audited Git blob hashes', async () => {
  const pins = {
    'render-engine/lottie/cursor-real-black.json': '2b98eb701d7f7f05e44105ffdcb537a3c588daa3',
    'render-engine/lottie/click-sunburst-soft-4-sm.json': '0b8a5f44b9fe047eb45c34c5cf974b9bdd26d95c',
    'modules/lottie/assets/click-sunburst-soft-xs.json': '4c76a9f49df95d771984b2372bb4aa43ebdaa686',
    'modules/lottie/assets/cursor-anim-filled-click.json': 'c81ffc8b98d3f74d2e53a9085bfeca522286f92f',
    'modules/lottie/assets/cursor-anim-filled-idle.json': '4075e071c67ff07c4d470c11d81dab15422d7689',
    'third-party/claude-remotion-editor/LICENSE': '0637361016291a72f18afbe471f956b201fde693',
    'modules/lottie/UPSTREAM-LICENSE': '0637361016291a72f18afbe471f956b201fde693'
  };
  for (const [file, sha] of Object.entries(pins)) {
    const bytes = Buffer.from(await read(file));
    const actual = crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
    assert.equal(actual, sha, file);
  }
});

// Record transformed Canvas path points, including scale and save/restore. This
// checks actual geometry rather than asserting a particular translate() sequence.
function recordingCanvas() {
  let matrix = [1, 1, 0, 0], points = [], drawings = [];
  const stack = [];
  const point = (x, y) => [matrix[0] * x + matrix[2], matrix[1] * y + matrix[3]];
  const ctx = {
    save() { stack.push([...matrix]); },
    restore() { matrix = stack.pop(); },
    translate(x, y) { matrix[2] += x * matrix[0]; matrix[3] += y * matrix[1]; },
    scale(x, y) { matrix[0] *= x; matrix[1] *= y; },
    clearRect() { drawings = []; },
    beginPath() { points = []; }, closePath() {},
    moveTo(x, y) { points.push(point(x, y)); },
    lineTo(x, y) { points.push(point(x, y)); },
    bezierCurveTo(a, b, c, d, x, y) { points.push(point(x, y)); },
    fill() { drawings.push({ type: 'fill', points: [...points] }); },
    stroke() { drawings.push({ type: 'stroke', points: [...points] }); }
  };
  return { canvas: { style: {}, getContext: () => ctx }, drawings: () => drawings };
}

test('cursor tip and burst stay aligned during tap press and moving swipe in both orientations', async () => {
  const runtime = await read('render-engine/gesture-overlay.js');
  const art = {
    cursor: JSON.parse(await read('render-engine/lottie/cursor-real-black.json')),
    burst: JSON.parse(await read('render-engine/lottie/click-sunburst-soft-4-sm.json')),
    burstSoft: JSON.parse(await read('modules/lottie/assets/click-sunburst-soft-xs.json'))
  };
  for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
    for (const effect of ['sunburst', 'sunburst-soft']) {
    for (const type of ['tap', 'swipe']) {
      const data = project(type, width, height);
      data.scenes[0].gestures[0].effect = effect;
      const recording = recordingCanvas();
      const window = { renderFrame() {} };
      const document = {
        getElementById(id) { return { textContent: JSON.stringify(id === 'motion-project-data' ? data : art) }; },
        createElement() { return recording.canvas; }, body: { appendChild() {} }
      };
      vm.runInNewContext(runtime, { window, document });
      const snapshots = [];
      for (const seconds of [0.2, 0.7, 0.9, 0.7]) {
        window.renderFrame(seconds);
        const drawings = recording.drawings();
        const tip = drawings.find(item => item.type === 'fill').points[1];
        const progress = type === 'tap' ? 1 : 1 - (1 - seconds) ** 3;
        const expected = [(0.3 + 0.4 * progress) * width, (0.4 + 0.2 * progress) * height];
        const near = (actual, wanted) => actual.forEach((v, i) => assert.ok(Math.abs(v - wanted[i]) < 1e-8));
        near(tip, expected);
        const rays = drawings.filter(item => item.type === 'stroke' && item.points.length === 2);
        if ((type === 'tap' && seconds > 0.55) || (type === 'swipe' && seconds > 0.75)) {
          assert.equal(rays.length, effect === 'sunburst' ? 4 : 8);
          const center = [0, 1].map(axis => rays.reduce((sum, ray) => sum + ray.points[0][axis], 0) / rays.length);
          near(center, tip);
        }
        snapshots.push(JSON.stringify(drawings));
      }
      assert.equal(snapshots[1], snapshots[3], 'repeated timestamp changed geometry');
      window.renderFrame(1.1);
      assert.equal(recording.drawings().length, 0);
    }
    }
  }
});
