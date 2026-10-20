import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

function getInlineScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, 'page must contain inline script');
  return scripts.at(-1)[1];
}

test('studio page includes password login and real render controls', async () => {
  const html = await fs.readFile(path.resolve('preview-studio.html'), 'utf8');
  const script = getInlineScript(html);
  assert.doesNotThrow(() => new Function(script));

  for (const id of [
    'loginOverlay', 'loginForm', 'adminPassword', 'logoutBtn', 'renderForm',
    'renderTemplate', 'renderDuration', 'renderFps', 'renderResolution',
    'renderCodec', 'renderAudioUrl', 'renderSubmitBtn', 'renderProgress',
    'renderStatus', 'renderVideo', 'downloadVideo',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(script, /\/api\/session\/login/);
  assert.match(script, /\/api\/studio\/render/);
  assert.match(script, /\/api\/studio\/jobs\//);
  assert.equal(script.includes('sessionStorage'), false);
  assert.equal(script.includes('localStorage'), false);
  assert.equal(script.includes('X-Admin-Token'), false);
  assert.equal(script.includes('X-Token'), false);
  assert.equal(script.includes('X-Signature'), false);
  assert.match(script, /getDownloadUrl/);
  assert.match(script, /startsWith\('\/api\/studio\/output\/'\)/);
  assert.match(script, /TEMPLATE_PREVIEW_MAP/);
  assert.match(script, /renderTemplate\.addEventListener\('change'/);
});

test('admin dashboard uses password session without browser token storage', async () => {
  const html = await fs.readFile(path.resolve('admin-dashboard.html'), 'utf8');
  const script = getInlineScript(html);
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
