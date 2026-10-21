import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, emptyProject, newId } from '../studio-assets/state.js';

const SCENE_ID_PATTERN = /^scn_[0-9a-f-]{36}$/;
const ELEMENT_ID_PATTERN = /^el_[0-9a-f-]{36}$/;

test('newId produces prefixed uuid-shaped identifiers', () => {
  const scene = newId('scn');
  const element = newId('el');
  assert.match(scene, SCENE_ID_PATTERN);
  assert.match(element, ELEMENT_ID_PATTERN);
  assert.notEqual(scene, element);
});

test('createStore backfills missing scene and element ids', () => {
  const store = createStore({
    schemaVersion: 1,
    title: 'Tanpa id',
    template: 'base',
    scenes: [{
      durationSec: 4,
      elements: [{ type: 'text', role: 'title', text: 'Judul' }],
    }],
  });

  const project = store.getProject();
  assert.equal(project.scenes.length, 1);
  assert.match(project.scenes[0].id, SCENE_ID_PATTERN);
  assert.match(project.scenes[0].elements[0].id, ELEMENT_ID_PATTERN);
});

test('setProject backfills ids for AI drafts and server drafts alike', () => {
  const store = createStore(emptyProject());
  const draft = {
    schemaVersion: 1,
    title: 'Draft AI',
    template: 'base',
    scenes: [{
      durationSec: 3,
      elements: [
        { type: 'text', role: 'subtitle', text: 'Sub' },
        { type: 'image', role: 'background', assetId: 'ast_00000000-0000-4000-8000-000000000000' },
      ],
    }],
  };

  store.setProject(draft);
  const afterCommit = store.getProject();
  assert.match(afterCommit.scenes[0].id, SCENE_ID_PATTERN);
  assert.match(afterCommit.scenes[0].elements[0].id, ELEMENT_ID_PATTERN);
  assert.match(afterCommit.scenes[0].elements[1].id, ELEMENT_ID_PATTERN);

  store.setProject(draft, { fromServer: true });
  const afterServer = store.getProject();
  assert.match(afterServer.scenes[0].id, SCENE_ID_PATTERN);
  assert.match(afterServer.scenes[0].elements[0].id, ELEMENT_ID_PATTERN);
});

test('addScene and addElement always mint identifiers', () => {
  const store = createStore(emptyProject());
  const sceneId = store.addScene();
  const elementId = store.addElement(sceneId, 'text');
  assert.match(sceneId, SCENE_ID_PATTERN);
  assert.match(elementId, ELEMENT_ID_PATTERN);

  const project = store.getProject();
  assert.equal(project.scenes[0].id, sceneId);
  assert.match(project.scenes[0].elements.find((element) => element.type === 'text').id, ELEMENT_ID_PATTERN);
});

test('undo and redo keep the server revision so the saved project stays updatable', () => {
  const store = createStore(emptyProject());
  const sceneId = store.addScene();
  store.setServerRevision(7);
  store.updateScene(sceneId, () => ({ durationSec: 9 }));

  store.undo();
  assert.equal(store.getRevision(), 7, 'undo is a local edit, not a new server revision');
  store.redo();
  assert.equal(store.getRevision(), 7, 'redo is a local edit, not a new server revision');
});

test('undo and redo keep identifiers stable', () => {
  const store = createStore(emptyProject());
  const sceneId = store.addScene();
  const before = store.getProject().scenes[0].elements.map((element) => element.id);

  store.updateScene(sceneId, () => ({ durationSec: 9 }));
  store.undo();
  assert.equal(store.getProject().scenes[0].id, sceneId);
  assert.deepEqual(store.getProject().scenes[0].elements.map((element) => element.id), before);

  store.redo();
  assert.equal(store.getProject().scenes[0].durationSec, 9);
  assert.deepEqual(store.getProject().scenes[0].elements.map((element) => element.id), before);
});
