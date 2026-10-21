import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const STUDIO_ASSETS = path.resolve('studio-assets');

async function readUi(name) {
  return fs.readFile(path.join(STUDIO_ASSETS, name), 'utf8');
}

test('studio shell includes password login and builder render controls', async () => {
  const html = await fs.readFile(path.resolve('preview-studio.html'), 'utf8');

  for (const id of [
    'loginOverlay', 'loginForm', 'adminPassword', 'logoutBtn', 'sessionState',
    'projectTitle', 'promptInput', 'generateBtn', 'assetDropZone', 'assetGrid',
    'previewFrame', 'timeline', 'inspectorForm', 'renderSubmitBtn', 'renderDuration',
    'renderFps', 'renderResolution', 'renderCodec', 'renderProgress', 'renderStatus',
    'renderJobId', 'renderProgressText', 'renderResult', 'renderVideo', 'downloadVideo',
    'undoBtn', 'redoBtn', 'saveBtn',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing id ${id}`);
  }

  assert.match(html, /type="module" src="\/api\/studio\/ui\/main\.js"/);
  assert.match(html, /href="\/api\/studio\/ui\/style\.css"/);
});

test('studio modules carry session, render and job endpoints without token storage', async () => {
  const [api, main, renderPanel] = await Promise.all([
    readUi('api.js'),
    readUi('main.js'),
    readUi('render-panel.js'),
  ]);

  assert.match(api, /SESSION_ROUTE = '\/api\/session'/);
  assert.match(api, /SESSION_ROUTE\}\/login/);
  assert.match(api, /SESSION_ROUTE\}\/logout/);
  assert.match(api, /STUDIO_ROUTE = '\/api\/studio'/);
  assert.match(api, /studio\('\/render'/);
  assert.match(api, /studio\(`\/jobs\//);
  assert.match(api, /X-CSRF-Token/);
  assert.match(main, /loadSession/);
  assert.match(renderPanel, /getDownloadUrl/);
  assert.match(renderPanel, /startsWith\('\/api\/studio\/output\/'\)/);

  const bundled = [api, main, renderPanel].join('\n');
  assert.equal(bundled.includes('X-Admin-Token'), false);
  assert.equal(bundled.includes('X-Token'), false);
  assert.equal(bundled.includes('X-Signature'), false);
  // CSRF is intentionally not copied into storage; the only persisted value is the project draft.
  assert.match(api, /never written\n \* to localStorage/);
});

test('admin dashboard uses password session without browser token storage', async () => {
  const html = await fs.readFile(path.resolve('admin-dashboard.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, 'page must contain inline script');
  const script = scripts.at(-1)[1];

  assert.doesNotThrow(() => new Function(script));

  assert.match(html, /id=["']loginOverlay["']/);
  assert.match(html, /id=["']loginForm["']/);
  assert.match(html, /id=["']adminPassword["']/);
  assert.match(html, /id=["']logoutBtn["']/);
  assert.match(script, /\/api\/session\/login/);
  assert.match(script, /X-CSRF-Token/);
  assert.equal(script.includes('ADMIN_TOKEN_STORAGE_KEY'), false);
  assert.equal(script.includes('promptForAdminToken'), false);
  assert.equal(script.includes('X-Admin-Token'), false);
});
