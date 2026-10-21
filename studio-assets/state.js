/**
 * Immutable project state with undo/redo and a recovery autosave.
 *
 * Only the project JSON is persisted — under a fixed key in localStorage — and it carries
 * no credential of any kind. The CSRF token, session cookie and API keys live elsewhere
 * (server-side or in page memory) and are never copied into storage.
 */

const RECOVERY_KEY = 'motionStudio.project.v1';
const MAX_HISTORY = 30;
const AUTOSAVE_DELAY_MS = 800;
const ASSET_ID_PATTERN = /^ast_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const TEMPLATE_IDS = ['base', 'kinetic-text', 'image-slideshow', 'video-mixer'];

function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function emptyProject() {
  return {
    schemaVersion: 1,
    title: 'Project baru',
    template: 'base',
    render: { duration: 10, fps: 30, width: 1280, height: 720, codec: 'h264' },
    theme: {
      backgroundColor: '#070913',
      primaryColor: '#38bdf8',
      accentColor: '#a855f7',
      fontFamily: 'Inter',
    },
    audio: null,
    scenes: [],
  };
}

function defaultTextElement() {
  return {
    id: newId('el'),
    type: 'text',
    role: 'title',
    text: 'Teks baru',
    x: 0.08,
    y: 0.42,
    width: 0.84,
    fontSize: 64,
    color: '#f1f5f9',
    align: 'left',
  };
}

function defaultScene() {
  return {
    id: newId('scn'),
    durationSec: 4,
    transition: { type: 'fade', durationSec: 0.5 },
    elements: [defaultTextElement()],
  };
}

function defaultVisualElement(type, assetId) {
  const base = {
    id: newId('el'),
    type,
    role: type === 'video' ? 'pip' : 'background',
    assetId,
    fit: 'cover',
  };
  if (type === 'video') {
    return { ...base, x: 0.62, y: 0.58, width: 0.32, muted: true, loop: true };
  }
  return { ...base, kenBurns: false, x: 0, y: 0, width: 1 };
}

/** Structural issues that block compile, save and render. Returns Indonesian messages. */
export function projectIssues(project) {
  const issues = [];
  if (!Array.isArray(project.scenes) || project.scenes.length === 0) {
    issues.push('Tambahkan minimal satu scene.');
  }
  if (project.audio !== null && project.audio !== undefined) {
    const audioAssetId = project.audio?.assetId;
    if (typeof audioAssetId !== 'string' || !ASSET_ID_PATTERN.test(audioAssetId)) {
      issues.push('Track audio belum terikat ke aset yang valid.');
    }
  }
  for (const [sceneIndex, scene] of (project.scenes || []).entries()) {
    for (const element of scene.elements || []) {
      if (element.type === 'text') continue;
      if (typeof element.assetId !== 'string' || !ASSET_ID_PATTERN.test(element.assetId)) {
        issues.push(`Scene ${sceneIndex + 1}: elemen ${element.type} belum terikat ke aset.`);
      }
    }
  }
  return issues;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Timeline selection, reorder and inspector edits are all keyed by scene/element id. The
 * server always normalizes incoming drafts and fills those ids in, but a draft that lost
 * them (older stored data, a schema change) would silently make every scene addressable as
 * `undefined`, so ids are backfilled here before the draft reaches the UI.
 */
function withIdentifiers(project) {
  return {
    ...project,
    scenes: (project.scenes || []).map((scene) => ({
      ...scene,
      id: scene.id || newId('scn'),
      elements: (scene.elements || []).map((element) => ({
        ...element,
        id: element.id || newId('el'),
      })),
    })),
  };
}

export function createStore(initialProject = emptyProject()) {
  let project = withIdentifiers(initialProject);
  let past = [];
  let future = [];
  let revision = null;
  let autosaveTimer = null;
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener(project);
  }

  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(persistRecovery, AUTOSAVE_DELAY_MS);
  }

  function persistRecovery() {
    try {
      localStorage.setItem(RECOVERY_KEY, JSON.stringify({ project, savedAt: new Date().toISOString() }));
    } catch {
      // Storage full or disabled: recovery is best-effort, never a hard failure.
    }
  }

  function commit(nextProject) {
    past.push(project);
    if (past.length > MAX_HISTORY) past.shift();
    future = [];
    project = withIdentifiers(nextProject);
    scheduleAutosave();
    notify();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getProject() {
      return project;
    },

    getRevision() {
      return revision;
    },

    setProject(nextProject, { fromServer = false } = {}) {
      if (fromServer) {
        project = withIdentifiers(nextProject);
        notify();
        return;
      }
      commit(clone(nextProject));
    },

    setServerRevision(value) {
      revision = value;
    },

    /** Server metadata changes are not user edits, so they do not enter undo history. */
    setServerIdentity(projectId, value) {
      if (typeof projectId === 'string' && projectId) {
        project = { ...project, projectId };
      }
      revision = value;
    },

    update(patchFactory) {
      commit({ ...project, ...patchFactory(clone(project)) });
    },

    updateScene(sceneId, patchFactory) {
      commit({
        ...project,
        scenes: project.scenes.map((scene) =>
          scene.id === sceneId ? { ...scene, ...patchFactory(clone(scene)) } : scene
        ),
      });
    },

    updateElement(sceneId, elementId, patchFactory) {
      commit({
        ...project,
        scenes: project.scenes.map((scene) =>
          scene.id !== sceneId
            ? scene
            : {
              ...scene,
              elements: scene.elements.map((element) =>
                element.id === elementId ? { ...element, ...patchFactory(clone(element)) } : element
              ),
            }
        ),
      });
    },

    addScene() {
      const scene = defaultScene();
      commit({ ...project, scenes: [...project.scenes, scene] });
      return scene.id;
    },

    addElement(sceneId, type = 'text', assetId = null) {
      const element = type === 'text' ? defaultTextElement() : defaultVisualElement(type, assetId);
      commit({
        ...project,
        scenes: project.scenes.map((scene) =>
          scene.id === sceneId ? { ...scene, elements: [...scene.elements, element] } : scene
        ),
      });
      return element.id;
    },

    removeScene(sceneId) {
      commit({ ...project, scenes: project.scenes.filter((scene) => scene.id !== sceneId) });
    },

    duplicateScene(sceneId) {
      const source = project.scenes.find((scene) => scene.id === sceneId);
      if (!source) return;
      const copy = clone(source);
      copy.id = newId('scn');
      copy.elements = copy.elements.map((element) => ({ ...element, id: newId('el') }));
      const index = project.scenes.findIndex((scene) => scene.id === sceneId);
      const scenes = [...project.scenes];
      scenes.splice(index + 1, 0, copy);
      commit({ ...project, scenes });
    },

    moveScene(sceneId, direction) {
      const index = project.scenes.findIndex((scene) => scene.id === sceneId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= project.scenes.length) return;
      const scenes = [...project.scenes];
      [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
      commit({ ...project, scenes });
    },

    removeElement(sceneId, elementId) {
      commit({
        ...project,
        scenes: project.scenes.map((scene) =>
          scene.id !== sceneId
            ? scene
            : { ...scene, elements: scene.elements.filter((element) => element.id !== elementId) }
        ),
      });
    },

    undo() {
      if (past.length === 0) return false;
      future.push(project);
      project = past.pop();
      scheduleAutosave();
      notify();
      return true;
    },

    redo() {
      if (future.length === 0) return false;
      past.push(project);
      project = future.pop();
      scheduleAutosave();
      notify();
      return true;
    },

    canUndo() {
      return past.length > 0;
    },

    canRedo() {
      return future.length > 0;
    },

    clearRecovery() {
      try {
        localStorage.removeItem(RECOVERY_KEY);
      } catch {
        // Ignore storage errors.
      }
    },

    hasRecovery() {
      try {
        return localStorage.getItem(RECOVERY_KEY) !== null;
      } catch {
        return false;
      }
    },

    loadRecovery() {
      try {
        const raw = localStorage.getItem(RECOVERY_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.project === 'object' ? parsed : null;
      } catch {
        return null;
      }
    },
  };
}

export { newId };
