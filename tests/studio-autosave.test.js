import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../studio-assets/autosave.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function project(overrides = {}) {
  return {
    schemaVersion: 1,
    title: 'Draft',
    template: 'base',
    render: { fps: 30, width: 1280, height: 720, codec: 'h264' },
    theme: {},
    scenes: [{ durationSec: 4, transition: { type: 'none', durationSec: 0.5 }, elements: [] }],
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  let currentProject = project();
  let revision = null;
  const states = [];
  const timeouts = [];
  const store = {
    getProject: () => currentProject,
    getRevision: () => revision,
    setProject: (next) => { currentProject = next; },
    setServerRevision: (next) => { revision = next; },
    clearRecovery: () => {},
  };
  const autosave = createAutosave({
    store,
    createProject: overrides.createProject || (async (draft) => ({
      project: { ...draft, projectId: 'prj_created' },
      revision: 1,
    })),
    saveProject: overrides.saveProject || (async (draft) => ({ project: draft, revision: 2 })),
    onStateChange: (state) => states.push(state),
    debounceMs: 10,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
  });
  return { autosave, store, states, timeouts, getProject: () => currentProject };
}

async function runNextTimer(harness) {
  const timer = harness.timeouts.find((item) => !item.cancelled && !item.ran);
  assert.ok(timer, 'expected a pending timer');
  timer.ran = true;
  await timer.callback();
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

test('three edits debounce into one save request', async () => {
  let saves = 0;
  const harness = createHarness({
    createProject: async (draft) => {
      saves += 1;
      return { project: { ...draft, projectId: 'prj_created' }, revision: 1 };
    },
  });

  harness.autosave.markDirty();
  harness.autosave.markDirty();
  harness.autosave.markDirty();
  await runNextTimer(harness);

  assert.equal(saves, 1);
  assert.equal(harness.autosave.getState().status, 'idle');
});

test('first save creates then later save updates', async () => {
  const calls = [];
  const harness = createHarness({
    createProject: async (draft) => {
      calls.push('create');
      return { project: { ...draft, projectId: 'prj_created' }, revision: 1 };
    },
    saveProject: async (draft, revision) => {
      calls.push(`save:${revision}`);
      return { project: draft, revision: 2 };
    },
  });

  harness.autosave.markDirty();
  await runNextTimer(harness);
  harness.autosave.markDirty();
  await runNextTimer(harness);

  assert.deepEqual(calls, ['create', 'save:1']);
});

test('only one request runs while later edits coalesce', async () => {
  const first = deferred();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const harness = createHarness({
    createProject: async (draft) => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      if (calls === 1) await first.promise;
      active -= 1;
      return { project: { ...draft, projectId: 'prj_created' }, revision: calls };
    },
    saveProject: async (draft) => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      active -= 1;
      return { project: draft, revision: calls };
    },
  });

  harness.autosave.markDirty();
  const firstFlush = runNextTimer(harness);
  await Promise.resolve();
  harness.autosave.markDirty();
  harness.autosave.markDirty();
  first.resolve();
  await firstFlush;
  await waitFor(() => calls === 2, 'coalesced save did not start');

  assert.equal(maximum, 1);
  assert.equal(calls, 2);
});

test('server error schedules retry and later succeeds', async () => {
  let calls = 0;
  const harness = createHarness({
    createProject: async (draft) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('Server unavailable');
        error.status = 503;
        throw error;
      }
      return { project: { ...draft, projectId: 'prj_created' }, revision: 1 };
    },
  });

  harness.autosave.markDirty();
  await runNextTimer(harness);
  assert.equal(harness.autosave.getState().status, 'retry_wait');
  assert.equal(harness.timeouts.find((item) => !item.ran && !item.cancelled).delay, 2000);

  await runNextTimer(harness);
  assert.equal(calls, 2);
  assert.equal(harness.autosave.getState().status, 'idle');
});

test('a successful save clears the crash recovery draft', async () => {
  const harness = createHarness();
  let cleared = 0;
  harness.store.clearRecovery = () => {
    cleared += 1;
  };

  const autosave = createAutosave({
    store: harness.store,
    createProject: async (draft) => ({
      project: { ...draft, projectId: 'prj_created' },
      revision: 1,
    }),
    saveProject: async (draft) => ({ project: draft, revision: 2 }),
    // The builder keeps editing its own project object, so the save must not adopt the
    // server copy — and must still drop the recovery draft.
    shouldUpdate: () => false,
    debounceMs: 10,
    setTimer: (callback) => ({ callback, cancelled: false }),
    clearTimer: () => {},
  });

  autosave.markDirty();
  await autosave.flush();

  assert.equal(autosave.getState().status, 'idle');
  assert.equal(cleared, 1);
});

test('revision conflict captures server project and stops retries', async () => {
  const serverProject = project({ projectId: 'prj_server', title: 'Server' });
  const conflict = new Error('Conflict');
  conflict.status = 409;
  conflict.body = { currentRevision: 7, project: serverProject };
  const harness = createHarness({ createProject: async () => { throw conflict; } });

  harness.autosave.markDirty();
  await runNextTimer(harness);

  const state = harness.autosave.getState();
  assert.equal(state.status, 'conflict');
  assert.equal(state.currentRevision, 7);
  assert.deepEqual(state.currentProject, serverProject);
  assert.equal(harness.timeouts.filter((item) => !item.ran && !item.cancelled).length, 0);
});
