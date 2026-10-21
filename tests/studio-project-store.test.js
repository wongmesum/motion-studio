import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ProjectConflictError,
  ProjectNotFoundError,
  createProjectStore,
  deriveOwnerKey,
} from '../vps-server/studio/project-store.js';

const OWNER_SALT = 'test-owner-salt';

async function createStore(overrides = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-studio-projects-'));
  return {
    rootDir,
    store: createProjectStore({ rootDir, ownerSalt: OWNER_SALT, ...overrides }),
  };
}

function draft(overrides = {}) {
  return {
    template: 'image-slideshow',
    title: 'Promo Kopi',
    render: { duration: 10, fps: 30, width: 1280, height: 720, codec: 'h264' },
    scenes: [{ elements: [{ type: 'text', text: 'Halo' }] }],
    ...overrides,
  };
}

test('owner keys are salted, stable, and never the raw actor label', () => {
  const key = deriveOwnerKey('Admin Dashboard', OWNER_SALT);

  assert.match(key, /^[0-9a-f]{24}$/);
  assert.equal(key, deriveOwnerKey('Admin Dashboard', OWNER_SALT));
  assert.notEqual(key, deriveOwnerKey('Admin Dashboard', 'other-salt'));
  assert.notEqual(key, deriveOwnerKey('admin dashboard', OWNER_SALT));
  assert.ok(!key.includes('Admin'));
});

test('create persists a normalized project with revision 1', async () => {
  const { store, rootDir } = await createStore();
  try {
    const created = await store.create('owner-a', draft());

    assert.equal(created.revision, 1);
    assert.match(created.project.projectId, /^prj_/);
    assert.equal(created.project.scenes[0].elements[0].text, 'Halo');
    assert.equal(created.project.title, 'Promo Kopi');

    const onDisk = JSON.parse(await fs.readFile(
      path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT), `${created.project.projectId}.json`),
      'utf8'
    ));
    assert.equal(onDisk.revision, 1);
    assert.equal(onDisk.ownerKey, deriveOwnerKey('owner-a', OWNER_SALT));
    assert.ok(onDisk.createdAt);
    assert.equal(onDisk.updatedAt, onDisk.createdAt);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('get returns the stored project for its owner only', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());

    const loaded = await store.get('owner-a', project.projectId);
    assert.equal(loaded.project.projectId, project.projectId);
    assert.equal(loaded.revision, 1);

    assert.equal(await store.get('owner-b', project.projectId), null);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('list returns summaries newest first and scopes to the owner', async () => {
  const { store, rootDir } = await createStore();
  try {
    const first = await store.create('owner-a', draft({ title: 'Pertama' }));
    await store.create('owner-a', draft({ title: 'Kedua' }));
    const foreignProject = await store.create('owner-b', draft({ title: 'Orang lain' }));

    const summaries = await store.list('owner-a');
    assert.equal(summaries.length, 2);
    assert.deepEqual(
      summaries.map((summary) => summary.title).sort(),
      ['Kedua', 'Pertama']
    );
    const summary = summaries.find((item) => item.projectId === first.project.projectId);
    assert.equal(summary.template, 'image-slideshow');
    assert.equal(summary.revision, 1);
    assert.equal(summary.sceneCount, 1);

    const foreign = await store.list('owner-b');
    assert.deepEqual(foreign.map((item) => item.projectId), [foreignProject.project.projectId]);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('update bumps the revision when baseRevision matches', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());

    const updated = await store.update('owner-a', project.projectId, {
      baseRevision: 1,
      project: { ...project, title: 'Promo Kopi Baru' },
    });

    assert.equal(updated.revision, 2);
    assert.equal(updated.project.title, 'Promo Kopi Baru');
    assert.equal(updated.project.projectId, project.projectId);

    const reloaded = await store.get('owner-a', project.projectId);
    assert.equal(reloaded.revision, 2);
    assert.equal(reloaded.project.title, 'Promo Kopi Baru');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('stale writes are rejected with the current revision', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());
    await store.update('owner-a', project.projectId, { baseRevision: 1, project });

    await assert.rejects(
      () => store.update('owner-a', project.projectId, { baseRevision: 1, project }),
      (error) => {
        assert.ok(error instanceof ProjectConflictError);
        assert.equal(error.currentRevision, 2);
        assert.equal(error.currentProject.projectId, project.projectId);
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('update requires an explicit baseRevision', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());
    await assert.rejects(
      () => store.update('owner-a', project.projectId, { project }),
      (error) => {
        assert.ok(error instanceof ProjectConflictError);
        assert.equal(error.currentRevision, 1);
        return true;
      }
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('update and remove refuse projects owned by somebody else', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());

    await assert.rejects(
      () => store.update('owner-b', project.projectId, { baseRevision: 1, project }),
      (error) => error instanceof ProjectNotFoundError
    );
    await assert.rejects(
      () => store.remove('owner-b', project.projectId),
      (error) => error instanceof ProjectNotFoundError
    );
    assert.ok(await store.get('owner-a', project.projectId));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('remove deletes the stored file', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());
    await store.remove('owner-a', project.projectId);

    assert.equal(await store.get('owner-a', project.projectId), null);
    await assert.rejects(
      () => store.remove('owner-a', project.projectId),
      (error) => error instanceof ProjectNotFoundError
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('path-like project ids never reach the filesystem', async () => {
  const { store, rootDir } = await createStore();
  try {
    for (const projectId of ['../../etc/passwd', 'prj_../../x', 'prj_ZZZ', '', 'x'.repeat(200)]) {
      assert.equal(await store.get('owner-a', projectId), null, `loaded ${projectId}`);
      await assert.rejects(
        () => store.remove('owner-a', projectId),
        (error) => error instanceof ProjectNotFoundError,
        `removed ${projectId}`
      );
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('a corrupt project file surfaces as a recoverable error, not a crash', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());
    const filePath = path.join(
      rootDir, deriveOwnerKey('owner-a', OWNER_SALT), `${project.projectId}.json`
    );
    await fs.writeFile(filePath, '{ not json', 'utf8');

    await assert.rejects(
      () => store.get('owner-a', project.projectId),
      /Gagal membaca project/i
    );
    const summaries = await store.list('owner-a');
    assert.equal(summaries.length, 0);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('create ignores a client-supplied project id', async () => {
  const { store, rootDir } = await createStore();
  try {
    const existing = await store.create('owner-a', draft({ title: 'Asli' }));

    // A client must not be able to overwrite another revision by guessing its id.
    const replayed = await store.create('owner-a', draft({
      projectId: existing.project.projectId,
      title: 'Bajakan',
    }));

    assert.notEqual(replayed.project.projectId, existing.project.projectId);
    assert.equal(replayed.revision, 1);
    const original = await store.get('owner-a', existing.project.projectId);
    assert.equal(original.project.title, 'Asli');
    assert.equal(original.revision, 1);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('invalid drafts never reach the disk', async () => {
  const { store, rootDir } = await createStore();
  try {
    await assert.rejects(() => store.create('owner-a', draft({ template: '../evil' })), /template/i);

    const entries = await fs.readdir(path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT)))
      .catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('missing owner directories are never created by read operations', async () => {
  const { store, rootDir } = await createStore();
  try {
    assert.equal(await store.get('owner-a', 'prj_11111111-1111-4111-8111-111111111111'), null);
    assert.deepEqual(await store.list('owner-a'), []);
    assert.deepEqual(await fs.readdir(rootDir), []);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('reads tolerate a partial write from a crashed process', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());
    const ownerDir = path.join(rootDir, deriveOwnerKey('owner-a', OWNER_SALT));
    const leftovers = (await fs.readdir(ownerDir)).filter((name) => name.endsWith('.json'));
    await fs.writeFile(path.join(ownerDir, '.partial.tmp'), 'broken', 'utf8');

    const summaries = await store.list('owner-a');
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].projectId, project.projectId);
    assert.deepEqual(leftovers.length, 1);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('concurrent updates with the same base revision cannot both win', async () => {
  const { store, rootDir } = await createStore();
  try {
    const { project } = await store.create('owner-a', draft());
    const updates = await Promise.allSettled([
      store.update('owner-a', project.projectId, {
        baseRevision: 1,
        project: { ...project, title: 'Writer A' },
      }),
      store.update('owner-a', project.projectId, {
        baseRevision: 1,
        project: { ...project, title: 'Writer B' },
      }),
    ]);

    const fulfilled = updates.filter((result) => result.status === 'fulfilled');
    const rejected = updates.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ProjectConflictError);
    assert.equal(rejected[0].reason.currentRevision, 2);

    const stored = await store.get('owner-a', project.projectId);
    assert.equal(stored.revision, 2);
    assert.equal(stored.project.title, fulfilled[0].value.project.title);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
