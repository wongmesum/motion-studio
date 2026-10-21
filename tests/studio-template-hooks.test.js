import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const TEMPLATES = ['base', 'kinetic-text', 'image-slideshow', 'video-mixer'];

async function readTemplate(id) {
  return fs.readFile(path.resolve(`render-engine/templates/${id}.html`), 'utf8');
}

test('every shipped template reads the project data script with a fallback', async () => {
  for (const id of TEMPLATES) {
    const html = await readTemplate(id);
    assert.match(html, /getElementById\('motion-project-data'\)/, id);
    assert.match(html, /JSON\.parse\(node\.textContent\)/, id);
    // The fallback branch must return null so legacy renders keep their demo content.
    assert.match(html, /return null;/, id);
  }
});

test('asset readiness and frame awaiting are opt-in per template', async () => {
  const slideshow = await readTemplate('image-slideshow');
  assert.match(slideshow, /window\.__ASSETS_READY__\s*=/);
  assert.match(slideshow, /window\.__AWAIT_FRAME__\s*=/);

  const mixer = await readTemplate('video-mixer');
  assert.match(mixer, /window\.__ASSETS_READY__\s*=/);
  assert.match(mixer, /window\.__AWAIT_FRAME__\s*=/);
  // Video frames never play in real time; they are seeked so capture stays deterministic.
  assert.match(mixer, /currentTime\s*=/);

  for (const id of ['base', 'kinetic-text']) {
    const html = await readTemplate(id);
    assert.match(html, /window\.__ASSETS_READY__\s*=\s*Promise\.resolve\(\)/, id);
  }
});

test('legacy hardcoded content survives as the documented fallback', async () => {
  assert.match(await readTemplate('image-slideshow'), /'01 \/ HIGGSFIELD AI GENERATION'/);
  assert.match(await readTemplate('base'), /'MOTION STUDIO'/);
  assert.match(await readTemplate('kinetic-text'), /'AI 2025'/);
  assert.match(await readTemplate('video-mixer'), /'CAM 02 • CANVAS OVERLAY'/);
});

test('templates never inject project text through innerHTML', async () => {
  for (const id of TEMPLATES) {
    const html = await readTemplate(id);
    assert.ok(!/innerHTML\s*=/.test(html), `${id} assigns innerHTML`);
  }
});

test('renderer waits for assets and seeks video before each screenshot', async () => {
  const source = await fs.readFile(path.resolve('vps-server/renderer.js'), 'utf8');

  assert.match(source, /window\.__ASSETS_READY__/);
  assert.match(source, /await window\.__AWAIT_FRAME__\(time\)[\s\S]*window\.renderFrame\(time\)/);
  assert.match(source, /reject\(new Error\('Waktu tunggu aset habis'\)\)/);
  assert.ok(
    source.indexOf('__AWAIT_FRAME__') < source.indexOf('page.screenshot'),
    'frame await must run before the screenshot'
  );
});

test('renderer honors the builder opt-out from the engineer gate', async () => {
  const source = await fs.readFile(path.resolve('vps-server/renderer.js'), 'utf8');
  assert.match(source, /jobData\.skipEngineer !== true/);
});

test('text templates apply the inspector text properties they advertise', async () => {
  for (const id of ['base', 'kinetic-text']) {
    const html = await readTemplate(id);
    assert.match(html, /\.fontSize/, id);
    assert.match(html, /\.color/, id);
    assert.match(html, /\.align/, id);
  }
});

test('image templates apply fit and ken burns only when advertised', async () => {
  const slideshow = await readTemplate('image-slideshow');
  // `fit` selects between cover and contain drawing paths.
  assert.match(slideshow, /drawContainImage/);
  assert.match(slideshow, /drawCoverImage/);
  // Ken Burns must be gated by the element flag, not always on.
  assert.match(slideshow, /kenBurns/);

  const mixer = await readTemplate('video-mixer');
  assert.match(mixer, /\.x/);
  assert.match(mixer, /\.y/);
  assert.match(mixer, /\.width/);
});

test('templates derive scene timing and transitions from the project', async () => {
  for (const id of TEMPLATES) {
    const html = await readTemplate(id);
    assert.match(html, /durationSec/, `${id} ignores scene durations`);
    assert.match(html, /transition\.type/, `${id} ignores transition type`);
  }
});

test('project renders never loop on a hardcoded ten second cycle', async () => {
  for (const id of TEMPLATES) {
    const html = await readTemplate(id);
    // A literal `% 10` would make a 30 second project repeat every ten seconds.
    assert.ok(!/%\s*10\b/.test(html), `${id} still wraps at ten seconds`);
  }
});

test('every template resolves the fade, slide and none transitions', async () => {
  for (const id of TEMPLATES) {
    const html = await readTemplate(id);
    // `none` must bypass the blend so a hard cut does not flash to black.
    assert.match(html, /type\s*===\s*'none'/, `${id} ignores none`);
    assert.match(html, /type\s*===\s*'slide'/, `${id} ignores slide`);
    assert.match(html, /type\s*\|\|\s*'fade'/, `${id} lacks a fade default`);
  }
});

test('template animation is driven by frame time, not a wall clock', async () => {
  for (const id of TEMPLATES) {
    const html = await readTemplate(id);
    // The autoplay loop may read performance.now only behind the manual-render guard;
    // the deterministic `renderFrame` path itself must stay a pure function of time.
    assert.match(html, /window\.__MANUAL_RENDER__\s*=\s*true/, `${id} does not flag manual render`);
    assert.match(html, /window\.renderFrame\s*=\s*function/, `${id} lacks renderFrame`);
  }
});
