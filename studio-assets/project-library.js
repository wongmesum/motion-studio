import {
  ApiError,
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
} from './api.js';
import { setButtonIcon } from './icons.js';

/**
 * Server-backed project library.
 *
 * Opening a project is the only place that adopts a stored identity, so the caller is
 * handed the project plus its revision and must also remember the project id for the
 * next save. Without that, the next save would POST a duplicate.
 */
export function createProjectLibrary({
  document: doc,
  notify,
  onOpen,
  onNew,
  onRenamed,
}) {
  const openBtn = doc.getElementById('openLibraryBtn');
  const overlay = doc.getElementById('libraryOverlay');
  const list = doc.getElementById('libraryList');
  const status = doc.getElementById('libraryStatus');
  const closeBtn = doc.getElementById('libraryCloseBtn');
  const newBtn = doc.getElementById('libraryNewBtn');

  setButtonIcon(openBtn, 'folder');
  setButtonIcon(closeBtn, 'close');

  let loading = false;
  let projects = [];

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.style.color = isError ? 'var(--rose)' : '';
  }

  function show() {
    overlay.classList.add('visible');
    closeBtn.focus();
    refresh();
  }

  function hide() {
    overlay.classList.remove('visible');
    openBtn.focus();
  }

  function itemButton(label, className, onClick) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  async function rename(entry) {
    const nextTitle = doc.defaultView.prompt('Nama project baru', entry.title);
    if (nextTitle === null) return;
    const title = nextTitle.trim();
    if (!title) {
      setStatus('Nama project tidak boleh kosong.', true);
      return;
    }

    try {
      const loaded = await loadProject(entry.projectId);
      const stored = await saveProject(
        { ...loaded.project, title },
        loaded.revision
      );
      setStatus('Nama project diperbarui.');
      notify('Nama project diperbarui.', 'success');
      if (onRenamed) onRenamed(stored);
      await refresh();
    } catch (error) {
      setStatus(error instanceof ApiError ? error.message : 'Gagal mengganti nama.', true);
    }
  }

  async function remove(entry) {
    if (!doc.defaultView.confirm(`Hapus project "${entry.title}"?`)) return;
    try {
      await deleteProject(entry.projectId);
      notify('Project dihapus.', 'success');
      await refresh();
    } catch (error) {
      setStatus(error instanceof ApiError ? error.message : 'Gagal menghapus project.', true);
    }
  }

  async function open(entry) {
    try {
      const stored = await loadProject(entry.projectId);
      hide();
      onOpen(stored);
    } catch (error) {
      setStatus(error instanceof ApiError ? error.message : 'Gagal membuka project.', true);
    }
  }

  function renderList() {
    if (loading) {
      list.replaceChildren(Object.assign(doc.createElement('p'), {
        className: 'empty-copy',
        textContent: 'Memuat project…',
      }));
      return;
    }
    if (projects.length === 0) {
      list.replaceChildren(Object.assign(doc.createElement('p'), {
        className: 'empty-copy',
        textContent: 'Belum ada project tersimpan.',
      }));
      return;
    }

    list.replaceChildren(...projects.map((entry) => {
      const row = doc.createElement('article');
      row.className = 'library-row';
      row.dataset.projectId = entry.projectId;

      const meta = doc.createElement('div');
      meta.className = 'library-meta';
      const title = doc.createElement('strong');
      title.textContent = entry.title;
      const detail = doc.createElement('span');
      detail.textContent = `${entry.sceneCount} scene • ${entry.durationSec} detik • rev ${entry.revision}`;
      meta.append(title, detail);

      const actions = doc.createElement('div');
      actions.className = 'library-actions';
      actions.append(
        itemButton('Buka', 'btn btn-primary btn-sm', () => open(entry)),
        itemButton('Ganti nama', 'btn btn-ghost btn-sm', () => rename(entry)),
        itemButton('Hapus', 'btn btn-danger btn-sm', () => remove(entry))
      );

      row.append(meta, actions);
      return row;
    }));
  }

  async function refresh() {
    loading = true;
    renderList();
    setStatus('');
    try {
      const body = await listProjects();
      projects = Array.isArray(body?.projects) ? body.projects : [];
      loading = false;
      renderList();
    } catch (error) {
      loading = false;
      projects = [];
      renderList();
      setStatus(error instanceof ApiError ? error.message : 'Daftar project tidak dapat dimuat.', true);
    }
  }

  openBtn.addEventListener('click', show);
  closeBtn.addEventListener('click', hide);
  newBtn.addEventListener('click', () => {
    hide();
    onNew();
  });

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) hide();
  });

  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.classList.contains('visible')) {
      event.preventDefault();
      hide();
    }
  });

  return {
    show,
    hide,
    refresh,
  };
}
