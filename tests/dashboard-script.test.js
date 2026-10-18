import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// The dashboard ships as a single HTML file, so a stray brace would only surface
// at runtime in the browser. Parse the inline script here instead.
test('admin dashboard inline script parses and exposes provider helpers', async () => {
  const htmlPath = path.resolve(process.cwd(), 'admin-dashboard.html');
  const html = await fs.readFile(htmlPath, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'dashboard must contain an inline script block');

  // Throws SyntaxError on malformed script, which fails the test.
  const parseScript = new Function(`${script[1]}\nreturn { getActiveProvider, buildCurlString, migrateLocalState };`);
  assert.equal(typeof parseScript, 'function');

  const source = script[1];
  assert.equal(source.includes('state.riverConfig'), false);
  assert.equal(source.includes('/api/admin/river/test'), false);
  assert.equal(source.includes('/api/admin/ai/test'), true);
});
