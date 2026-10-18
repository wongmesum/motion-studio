import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getAllowedRenderHosts,
  isAllowedRemoteAssetUrl,
  isAllowedRenderUrl,
} from '../vps-server/security/network-policy.js';

const allowedHosts = getAllowedRenderHosts();

test('network policy allows only exact trusted CDN hostnames', () => {
  assert.equal(
    isAllowedRenderUrl('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js', allowedHosts),
    true
  );
  assert.equal(
    isAllowedRenderUrl('https://cdn.jsdelivr.net.evil.com/x.js', allowedHosts),
    false,
    'lookalike host must be rejected'
  );
  assert.equal(
    isAllowedRenderUrl('https://evil.com/cdn.jsdelivr.net/x.js', allowedHosts),
    false,
    'trusted hostname in path must not grant access'
  );
  assert.equal(isAllowedRenderUrl('https://evil.com/x.js', allowedHosts), false);
});

test('network policy allows inline schemes and trusted local asset files', () => {
  const trustedAsset = pathToFileURL(path.resolve(process.cwd(), 'cache', 'asset-1.jpg')).href;
  assert.equal(isAllowedRenderUrl('data:image/png;base64,iVBORw0KGgo=', allowedHosts), true);
  assert.equal(isAllowedRenderUrl('blob:http://localhost/abc', allowedHosts), true);
  assert.equal(isAllowedRenderUrl('about:blank', allowedHosts), true);
  assert.equal(isAllowedRenderUrl(trustedAsset, allowedHosts), true);
});

test('network policy blocks sensitive local paths and plain http', () => {
  assert.equal(isAllowedRenderUrl('file:///etc/passwd', allowedHosts), false);
  assert.equal(isAllowedRenderUrl('file:///proc/self/environ', allowedHosts), false);
  assert.equal(isAllowedRenderUrl('file:///sys/kernel/notes', allowedHosts), false);
  assert.equal(isAllowedRenderUrl('file:///home/user/.ssh/id_rsa', allowedHosts), false);
  assert.equal(
    isAllowedRenderUrl(pathToFileURL(path.resolve(os.homedir(), '.ssh', 'id_rsa')).href, allowedHosts),
    false,
    'file outside trusted asset directories must be rejected'
  );
  assert.equal(isAllowedRenderUrl('http://cdn.jsdelivr.net/npm/gsap.js', allowedHosts), false);
  assert.equal(isAllowedRenderUrl('not-a-url', allowedHosts), false);
  assert.equal(isAllowedRenderUrl('', allowedHosts), false);
  assert.equal(isAllowedRenderUrl(null, allowedHosts), false);
});

test('remote asset download policy blocks SSRF targets', () => {
  assert.equal(
    isAllowedRemoteAssetUrl('https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js', allowedHosts),
    true
  );
  assert.equal(isAllowedRemoteAssetUrl('http://169.254.169.254/latest/meta-data/', allowedHosts), false);
  assert.equal(isAllowedRemoteAssetUrl('http://127.0.0.1:9000/minio/', allowedHosts), false);
  assert.equal(isAllowedRemoteAssetUrl('http://minio:9000/internal', allowedHosts), false);
  assert.equal(isAllowedRemoteAssetUrl('file:///etc/passwd', allowedHosts), false);
  assert.equal(isAllowedRemoteAssetUrl('https://evil.com/asset.jpg', allowedHosts), false);
});

test('network policy honors RENDER_ALLOWED_HOSTS extension', () => {
  process.env.RENDER_ALLOWED_HOSTS = 'assets.example.com';
  const extended = getAllowedRenderHosts();
  assert.equal(isAllowedRenderUrl('https://assets.example.com/a.png', extended), true);
  assert.equal(isAllowedRenderUrl('https://cdn.jsdelivr.net/a.png', extended), true);
  delete process.env.RENDER_ALLOWED_HOSTS;
});
