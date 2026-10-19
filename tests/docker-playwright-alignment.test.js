import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relativePath), 'utf8'));
}

async function readText(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), 'utf8');
}

test('the Playwright image tag matches the installed Playwright version', async () => {
  const dockerfile = await readText('vps-server/Dockerfile');
  const imageTag = dockerfile.match(/FROM\s+mcr\.microsoft\.com\/playwright:v([0-9.]+)-/)?.[1];
  assert.ok(imageTag, 'the VPS Dockerfile must pin a versioned Playwright image');

  // Playwright cannot find its browser executables when the image version and the
  // installed package version differ, so these two must move together.
  const rootLockfile = await readJson('package-lock.json');
  const vpsLockfile = await readJson('vps-server/package-lock.json');
  const installedPlaywright = rootLockfile.packages['node_modules/playwright'].version;
  const vpsInstalledPlaywright = vpsLockfile.packages['node_modules/playwright'].version;
  const rootPlaywright = (await readJson('package.json')).dependencies.playwright;
  const vpsPlaywright = (await readJson('vps-server/package.json')).dependencies.playwright;
  assert.equal(imageTag, installedPlaywright, 'Dockerfile image tag must match the root lockfile');
  assert.equal(imageTag, vpsInstalledPlaywright, 'Dockerfile image tag must match the VPS lockfile');
  // Exact specifiers, not ranges: a caret would let the package float to a version
  // the pinned image tag does not ship browsers for.
  assert.equal(rootPlaywright, installedPlaywright, 'root manifest must pin Playwright to an exact version');
  assert.equal(vpsPlaywright, vpsInstalledPlaywright, 'VPS manifest must pin Playwright to an exact version');
});

test('the VPS image installs from the lockfile instead of re-resolving ranges', async () => {
  const dockerfile = await readText('vps-server/Dockerfile');
  assert.match(
    dockerfile,
    /COPY\s+package\.json\s+package-lock\.json\s+\.\//,
    'the VPS Dockerfile must copy the lockfile alongside the manifest'
  );
  assert.match(dockerfile, /RUN\s+npm\s+ci\s+--omit=dev/, 'the VPS Dockerfile must install with npm ci');
  assert.doesNotMatch(
    dockerfile,
    /RUN\s+npm\s+install/,
    'npm install would ignore the lockfile and could drift from the pinned Playwright image'
  );
});

test('the VPS Docker context excludes host dependencies and runtime data', async () => {
  const dockerignore = await readText('vps-server/.dockerignore');
  const ignoredPaths = new Set(
    dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );

  for (const requiredPath of ['node_modules/', '.env', '.env.*', 'data/', 'cache/', 'output/', 'frames/']) {
    assert.ok(ignoredPaths.has(requiredPath), `${requiredPath} must be excluded from the VPS Docker context`);
  }
});

test('the declared Node engine satisfies sharp requirements', async () => {
  const engines = (await readJson('package.json')).engines?.node;
  assert.ok(engines, 'the root manifest must declare a Node engine range');
  const minimum = Number(engines.match(/(\d+)\.(\d+)/)?.slice(1, 3).join('.') || 0);
  // sharp 0.35 declares node >=20.9.0; a looser engine claim would let CI install it on Node 20.0.
  assert.ok(minimum >= 20.9, `engine range ${engines} is looser than sharp's required >=20.9.0`);
});
