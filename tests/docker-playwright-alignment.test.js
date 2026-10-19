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
    /COPY\s+vps-server\/package\.json\s+vps-server\/package-lock\.json\s+\.\//,
    'the VPS Dockerfile must copy the lockfile alongside the manifest'
  );
  assert.match(dockerfile, /RUN\s+npm\s+ci\s+--omit=dev/, 'the VPS Dockerfile must install with npm ci');
  assert.doesNotMatch(
    dockerfile,
    /RUN\s+npm\s+install/,
    'npm install would ignore the lockfile and could drift from the pinned Playwright image'
  );
});

test('the VPS image preserves the project layout required by server routes', async () => {
  const [dockerfile, compose] = await Promise.all([
    readText('vps-server/Dockerfile'),
    readText('docker-compose.yml'),
  ]);
  assert.match(compose, /context:\s*\.\s*\n\s*dockerfile:\s*vps-server\/Dockerfile/);
  assert.match(dockerfile, /WORKDIR\s+\/app\/vps-server[\s\S]*COPY\s+vps-server\/\s+\.\//);
  assert.match(dockerfile, /COPY\s+admin-dashboard\.html\s+preview-studio\.html\s+\.\//);
  assert.match(dockerfile, /COPY\s+render-engine\/\s+\.\/render-engine/);
  assert.match(dockerfile, /CMD\s+\["node",\s*"vps-server\/server\.js"\]/);
});

test('the root Docker context excludes host dependencies, secrets, and runtime data', async () => {
  const dockerignore = await readText('.dockerignore');
  const ignoredPaths = new Set(
    dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );

  for (const requiredPath of ['node_modules/', '**/node_modules/', '.env', '.env.*', 'vps-server/data/', 'cache/', 'output/', 'frames/', 'tools/']) {
    assert.ok(ignoredPaths.has(requiredPath), `${requiredPath} must be excluded from the root Docker context`);
  }
});

test('Compose pins Redis and exposes only the application port on loopback', async () => {
  const compose = await readText('docker-compose.yml');
  assert.match(
    compose,
    /image:\s+redis:7-alpine@sha256:[a-f0-9]{64}/,
    'production Redis must be immutable instead of following a moving tag'
  );
  assert.doesNotMatch(compose, /"6379:6379"/);
  assert.doesNotMatch(compose, /"900[01]:900[01]"/);
  assert.doesNotMatch(compose, /image:\s+minio\/minio/, 'removed upstream MinIO image must not block deployment');
  assert.match(compose, /"127\.0\.0\.1:\$\{PORT:-3000}:3000"/);
});

test('Compose labels bind mounts for SELinux hosts', async () => {
  const compose = await readText('docker-compose.yml');
  for (const containerPath of [
    '/app/vps-server/data',
    '/app/output',
    '/app/cache',
    '/app/frames',
  ]) {
    assert.match(compose, new RegExp(`${containerPath}:z`));
  }
});

test('the declared Node engine satisfies sharp requirements', async () => {
  const engines = (await readJson('package.json')).engines?.node;
  assert.ok(engines, 'the root manifest must declare a Node engine range');
  const minimum = Number(engines.match(/(\d+)\.(\d+)/)?.slice(1, 3).join('.') || 0);
  // sharp 0.35 declares node >=20.9.0; a looser engine claim would let CI install it on Node 20.0.
  assert.ok(minimum >= 20.9, `engine range ${engines} is looser than sharp's required >=20.9.0`);
});
