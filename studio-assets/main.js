import {
  createProject,
  listTemplates,
  loadSession,
  login,
  logout,
  saveProject,
  setSessionHandler,
  validateProject,
} from './api.js';
import { createAssetsPanel } from './assets-panel.js';
import { createAutosave } from './autosave.js';
import { setButtonIcon } from './icons.js';
import { createInspector } from './inspector.js';
import { createPreviewFrame } from './preview-frame.js';
import { downloadProject, importProjectFile } from './project-io.js';
import { createProjectLibrary } from './project-library.js';
import { formatDuration, sumSceneDurations } from './project-utils.js';
import { createPromptPanel } from './prompt-panel.js';
import { createRenderPanel } from './render-panel.js';
import { createStore, emptyProject, newId, projectIssues } from './state.js';
import { createTimeline } from './timeline.js';

const doc = document;
const store = createStore(emptyProject());
const loginOverlay = doc.getElementById('loginOverlay');
const loginForm = doc.getElementById('loginForm');
const loginError = doc.getElementById('loginError');
const loginSubmitBtn = doc.getElementById('loginSubmitBtn');
const logoutBtn = doc.getElementById('logoutBtn');
const sessionState = doc.getElementById('sessionState');
const titleInput = doc.getElementById('projectTitle');
const templateSelect = doc.getElementById('templateSelect');
const saveBtn = doc.getElementById('saveBtn');
const saveState = doc.getElementById('saveState');
const conflictBanner = doc.getElementById('conflictBanner');
const loadServerBtn = doc.getElementById('loadServerBtn');
const saveAsCopyBtn = doc.getElementById('saveAsCopyBtn');
const undoBtn = doc.getElementById('undoBtn');
const redoBtn = doc.getElementById('redoBtn');
const toastRegion = doc.getElementById('toastRegion');
const useAiHtml = doc.getElementById('useAiHtml');

const exportProjectBtn = doc.getElementById('exportProjectBtn');
const importProjectBtn = doc.getElementById('importProjectBtn');
const importProjectInput = doc.getElementById('importProjectInput');

setButtonIcon(undoBtn, 'undo');
setButtonIcon(redoBtn, 'redo');
setButtonIcon(doc.getElementById('refreshAssetsBtn'), 'refresh');
setButtonIcon(doc.getElementById('refreshPreviewBtn'), 'refresh');
setButtonIcon(exportProjectBtn, 'download');
setButtonIcon(importProjectBtn, 'upload');

let authenticated = false;
let booted = false;
let lastKnownProjectId = null;
let suppressAutosave = false;

const SAVE_LABELS = {
  idle: ['Tersimpan', 'saved'],
  dirty: ['Perubahan belum disimpan', 'dirty'],
  saving: ['Menyimpan…', 'saving'],
  retry_wait: ['Mencoba lagi…', 'retry'],
  conflict: ['Konflik versi', 'error'],
  error: ['Gagal menyimpan', 'error'],
};

function showSaveState({ status }) {
  const [label, state] = SAVE_LABELS[status] || SAVE_LABELS.error;
  saveState.textContent = label;
  saveState.dataset.state = state;
  saveBtn.disabled = status === 'saving';
  conflictBanner.hidden = status !== 'conflict';
}

const autosave = createAutosave({
  store,
  createProject,
  saveProject,
  shouldUpdate: () => false,
  onSaved: (stored) => {
    lastKnownProjectId = stored?.project?.projectId ?? lastKnownProjectId;
  },
  onStateChange: showSaveState,
});

function notify(message, tone = 'info') {
  const toast = doc.createElement('div');
  toast.className = 'toast';
  toast.dataset.tone = tone;
  toast.textContent = message;
  toastRegion.append(toast);
  setTimeout(() => toast.remove(), 5000);
}

function showLogin(message = '') {
  authenticated = false;
  loginOverlay.classList.add('visible');
  logoutBtn.hidden = true;
  sessionState.textContent = 'Belum login';
  loginError.textContent = message;
  doc.getElementById('adminPassword').focus();
}

function showSession(session) {
  authenticated = true;
  loginOverlay.classList.remove('visible');
  logoutBtn.hidden = false;
  sessionState.textContent = session?.actor ? `Login: ${session.actor}` : 'Login aktif';
  loginError.textContent = '';
}

setSessionHandler(showLogin);

const assetsPanel = createAssetsPanel({
  document: doc,
  notify,
  onAssetsChanged: () => inspector.render(),
});

const inspector = createInspector({ document: doc, store, assetsPanel, notify });

const timeline = createTimeline({
  document: doc,
  store,
  notify,
  bindAsset: (sceneId, assetId) => inspector.bindAsset(sceneId, assetId),
  onSelectionChanged: (selection) => inspector.select(selection),
});

const preview = createPreviewFrame({
  document: doc,
  store,
  projectIssues,
  notify,
  getUseAiHtml: () => useAiHtml.checked,
});

function renewSceneIdentifiers(scene) {
  return {
    ...scene,
    id: newId('scn'),
    elements: (scene.elements || []).map((element) => ({
      ...element,
      id: newId('el'),
    })),
  };
}

const promptPanel = createPromptPanel({
  document: doc,
  notify,
  isBusy: () => !authenticated,
  onGenerated: ({ project, mode }) => {
    const current = store.getProject();
    const generatedScenes = (project.scenes || []).map(renewSceneIdentifiers);
    const scenes = mode === 'append'
      ? [...current.scenes, ...generatedScenes]
      : generatedScenes;

    store.setProject({
      ...project,
      projectId: current.projectId,
      title: project.title || current.title,
      scenes,
    });
    timeline.select(generatedScenes[0]?.id || current.scenes[0]?.id || null);
  },
});

const renderPanel = createRenderPanel({ document: doc, store, notify });

/** Adopts a server-stored project, including the identity the next save must use. */
function adoptServerProject(stored) {
  suppressAutosave = true;
  try {
    store.setProject(stored.project, { fromServer: true });
  } finally {
    suppressAutosave = false;
  }
  store.setServerRevision(stored.revision);
  lastKnownProjectId = stored.project.projectId;
  store.clearRecovery();
  autosave.adopt({ revision: stored.revision });
  saveState.textContent = 'Tersimpan';
  saveState.dataset.state = 'saved';
}

const projectLibrary = createProjectLibrary({
  document: doc,
  notify,
  onOpen: (stored) => {
    adoptServerProject(stored);
    timeline.select(stored.project.scenes?.[0]?.id || null);
    notify('Project dibuka.', 'success');
  },
  onNew: () => {
    suppressAutosave = true;
    try {
      store.setProject(emptyProject(), { fromServer: true });
    } finally {
      suppressAutosave = false;
    }
    store.setServerRevision(null);
    lastKnownProjectId = null;
    store.clearRecovery();
    autosave.reset();
    applyProjectToControls(store.getProject());
    timeline.select(null);
    titleInput.focus();
  },
  onRenamed: (stored) => {
    if (stored?.project?.projectId !== lastKnownProjectId) return;
    adoptServerProject(stored);
  },
});

function applyProjectToControls(project) {
  if (titleInput.value !== project.title) titleInput.value = project.title;
  if (templateSelect.value !== project.template) templateSelect.value = project.template;
  const renderDuration = doc.getElementById('renderDuration');
  renderDuration.value = formatDuration(sumSceneDurations(project));
  renderDuration.readOnly = true;
  renderDuration.setAttribute('aria-readonly', 'true');
  doc.getElementById('renderFps').value = String(project.render.fps);
  doc.getElementById('renderResolution').value = `${project.render.width}x${project.render.height}`;
  doc.getElementById('renderCodec').value = project.render.codec;
  undoBtn.disabled = !store.canUndo();
  redoBtn.disabled = !store.canRedo();
}

store.subscribe((project) => {
  applyProjectToControls(project);
  timeline.render(project);
  inspector.render();
  preview.scheduleCompile();
  if (authenticated && !suppressAutosave) autosave.markDirty();
});

async function loadTemplatesIntoSelect() {
  const { templates = [] } = await listTemplates();
  templateSelect.replaceChildren(...templates.map(({ id, label }) => {
    const option = doc.createElement('option');
    option.value = id;
    option.textContent = label;
    return option;
  }));
  const project = store.getProject();
  if (templates.some(({ id }) => id === project.template)) templateSelect.value = project.template;
}

function restoreRecoveryDraft() {
  const recovery = store.loadRecovery();
  if (!recovery?.project || projectIssues(recovery.project).some((issue) => issue.includes('terikat'))) return;
  const confirmed = window.confirm('Draft pemulihan ditemukan. Pulihkan perubahan lokal?');
  if (confirmed) store.setProject(recovery.project);
}

async function saveCurrentProject() {
  const project = store.getProject();
  const issues = projectIssues(project);
  if (issues.length > 0) {
    notify(issues[0], 'error');
    return;
  }

  try {
    const stored = await autosave.flush();
    if (stored) notify('Project tersimpan.', 'success');
  } catch (error) {
    notify(error.message || 'Project gagal disimpan.', 'error');
  }
}

loadServerBtn.addEventListener('click', () => {
  const state = autosave.getState();
  if (!state.currentProject) return;
  adoptServerProject({
    project: state.currentProject,
    revision: state.currentRevision,
  });
  timeline.select(state.currentProject.scenes?.[0]?.id || null);
  notify('Versi server dimuat.', 'success');
});

saveAsCopyBtn.addEventListener('click', async () => {
  const localCopy = { ...store.getProject() };
  delete localCopy.projectId;
  saveAsCopyBtn.disabled = true;
  try {
    const stored = await createProject(localCopy);
    adoptServerProject(stored);
    timeline.select(stored.project.scenes?.[0]?.id || null);
    notify('Salinan project tersimpan.', 'success');
  } catch (error) {
    notify(error.message || 'Salinan project gagal disimpan.', 'error');
  } finally {
    saveAsCopyBtn.disabled = false;
  }
});

async function bootStudio() {
  if (booted) return;
  booted = true;
  await Promise.all([loadTemplatesIntoSelect(), assetsPanel.init(), promptPanel.init()]);
  restoreRecoveryDraft();
  const project = store.getProject();
  applyProjectToControls(project);
  timeline.render(project);
  preview.updateTimeLabel();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginSubmitBtn.disabled = true;
  loginError.textContent = '';
  try {
    const session = await login(doc.getElementById('adminPassword').value);
    doc.getElementById('adminPassword').value = '';
    showSession(session);
    await bootStudio();
  } catch (error) {
    showLogin(error.message || 'Password tidak valid.');
  } finally {
    loginSubmitBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  renderPanel.stopPolling();
  preview.stopPlayback();
  await logout().catch(() => {});
  showLogin();
});

titleInput.addEventListener('input', () => {
  store.update(() => ({ title: titleInput.value || 'Project baru' }));
});

templateSelect.addEventListener('change', () => {
  store.update(() => ({ template: templateSelect.value }));
});

saveBtn.addEventListener('click', saveCurrentProject);
exportProjectBtn.addEventListener('click', () => {
  try {
    downloadProject(store.getProject());
    notify('Project JSON diekspor.', 'success');
  } catch (error) {
    notify(error.message || 'Project gagal diekspor.', 'error');
  }
});
importProjectBtn.addEventListener('click', () => importProjectInput.click());
importProjectInput.addEventListener('change', async () => {
  const [file] = importProjectInput.files || [];
  if (!file) return;

  importProjectBtn.disabled = true;
  try {
    const importedProject = await importProjectFile(file, validateProject);
    store.setProject(importedProject);
    store.setServerRevision(null);
    lastKnownProjectId = null;
    autosave.reset();
    timeline.select(importedProject.scenes?.[0]?.id || null);
    notify('Project JSON diimpor sebagai salinan baru.', 'success');
  } catch (error) {
    notify(error.message || 'Project gagal diimpor.', 'error');
  } finally {
    importProjectInput.value = '';
    importProjectBtn.disabled = false;
  }
});
undoBtn.addEventListener('click', () => store.undo());
redoBtn.addEventListener('click', () => store.redo());
useAiHtml.addEventListener('change', () => preview.compile());

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) store.redo();
    else store.undo();
    return;
  }
  if (event.altKey && event.key === 'ArrowUp') {
    event.preventDefault();
    timeline.moveSelected(-1);
  }
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    timeline.moveSelected(1);
  }
  if (event.key === 'Delete' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) {
    timeline.removeSelectedElement();
  }
  if (event.key === 'Escape' && loginOverlay.classList.contains('visible')) {
    doc.getElementById('adminPassword').focus();
  }
});

window.addEventListener('pagehide', () => {
  renderPanel.stopPolling();
  preview.stopPlayback();
  autosave.dispose();
});

loadSession()
  .then(async (session) => {
    if (!session) {
      showLogin();
      return;
    }
    showSession(session);
    await bootStudio();
  })
  .catch((error) => showLogin(error.message || 'Layanan sesi sedang tidak tersedia.'));
