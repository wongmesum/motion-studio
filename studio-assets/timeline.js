function sceneLabel(scene, index) {
  const title = scene.elements?.find((element) => element.type === 'text')?.text;
  return title || `Scene ${index + 1}`;
}

function countElements(project) {
  return project.scenes.reduce((total, scene) => total + (scene.elements?.length || 0), 0);
}

import { iconMarkup } from './icons.js';

/** Horizontal scene timeline with selection, reorder, duplicate, and drop-to-bind. */
export function createTimeline({
  document: doc,
  store,
  notify,
  bindAsset,
  onSelectionChanged,
}) {
  const timeline = doc.getElementById('timeline');
  const addSceneBtn = doc.getElementById('addSceneBtn');
  const summary = doc.getElementById('sceneSummary');

  let selectedSceneId = null;
  let selectedElementId = null;

  function select(sceneId, elementId = null) {
    selectedSceneId = sceneId;
    selectedElementId = elementId;
    render(store.getProject());
    onSelectionChanged({ sceneId, elementId });
  }

  function elementRow(scene, element) {
    const row = doc.createElement('button');
    row.type = 'button';
    row.className = `element-row${element.id === selectedElementId ? ' is-selected' : ''}`;
    row.dataset.elementId = element.id;
    row.innerHTML = `<span class="type-tag">${element.type}</span><span class="row-text"></span><span>${element.role || ''}</span>`;
    row.querySelector('.row-text').textContent = element.type === 'text'
      ? element.text
      : (element.assetId ? 'Aset terikat' : 'Belum ada aset');
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      select(scene.id, element.id);
    });
    return row;
  }

  function render(project) {
    summary.textContent = `${project.scenes.length} scene • ${countElements(project)} elemen`;
    if (project.scenes.length === 0) {
      timeline.innerHTML = '<div class="timeline-empty"><strong>Timeline kosong</strong><span>Generate struktur atau tambah scene manual.</span></div>';
      return;
    }

    if (!project.scenes.some((scene) => scene.id === selectedSceneId)) {
      selectedSceneId = project.scenes[0].id;
      selectedElementId = null;
    }

    timeline.replaceChildren(...project.scenes.map((scene, index) => {
      const card = doc.createElement('article');
      card.className = `scene-card${scene.id === selectedSceneId ? ' is-selected' : ''}`;
      card.dataset.sceneId = scene.id;
      card.tabIndex = 0;
      card.draggable = true;

      const head = doc.createElement('div');
      head.className = 'scene-card-head';
      head.innerHTML = `<span class="scene-index">SCENE ${String(index + 1).padStart(2, '0')}</span><span class="scene-duration">${scene.durationSec}s</span>`;
      const title = doc.createElement('span');
      title.className = 'scene-title';
      title.textContent = sceneLabel(scene, index);

      const chips = doc.createElement('div');
      chips.className = 'scene-elements';
      chips.replaceChildren(...['text', 'image', 'video'].map((type) => {
        const count = scene.elements.filter((element) => element.type === type).length;
        const chip = doc.createElement('span');
        chip.className = 'scene-chip';
        chip.textContent = `${count} ${type}`;
        return chip;
      }));

      const elements = doc.createElement('div');
      elements.className = 'element-list';
      if (scene.id === selectedSceneId) {
        elements.replaceChildren(...scene.elements.map((element) => elementRow(scene, element)));
      }

      const actions = doc.createElement('div');
      actions.className = 'scene-card-actions';
      const actionButtons = [
        { action: 'left', label: 'Pindah ke kiri', icon: 'chevronLeft' },
        { action: 'copy', label: 'Duplikat scene', icon: 'copy' },
        { action: 'right', label: 'Pindah ke kanan', icon: 'chevronRight' },
        { action: 'delete', label: 'Hapus scene', icon: 'trash' },
      ];
      actionButtons.forEach(({ action, label, icon }) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.setAttribute('aria-label', label);
        button.innerHTML = iconMarkup(icon);
        actions.append(button);
      });
      actions.addEventListener('click', (event) => {
        event.stopPropagation();
        const action = event.target.closest('button')?.dataset.action;
        if (action === 'left') store.moveScene(scene.id, -1);
        if (action === 'right') store.moveScene(scene.id, 1);
        if (action === 'copy') store.duplicateScene(scene.id);
        if (action === 'delete') {
          if (!doc.defaultView.confirm('Hapus scene ini?')) return;
          const scenes = store.getProject().scenes;
          const removedIndex = scenes.findIndex((item) => item.id === scene.id);
          store.removeScene(scene.id);
          const remaining = store.getProject().scenes;
          // Keep the author near where they were: the scene that slid into the removed
          // slot, otherwise the previous one, otherwise nothing.
          const nextScene = remaining[removedIndex] || remaining[removedIndex - 1] || null;
          select(nextScene ? nextScene.id : null);
        }
      });

      card.append(head, title, chips, elements, actions);
      card.addEventListener('click', () => select(scene.id));
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(scene.id);
        }
      });
      card.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('application/x-motion-scene', scene.id);
        event.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragover', (event) => {
        const types = [...event.dataTransfer.types];
        if (types.includes('text/plain')) {
          event.preventDefault();
          card.classList.add('is-drag-over');
        }
      });
      card.addEventListener('dragleave', () => card.classList.remove('is-drag-over'));
      card.addEventListener('drop', (event) => {
        card.classList.remove('is-drag-over');
        const assetId = event.dataTransfer.getData('text/plain');
        if (!assetId.startsWith('ast_')) return;
        event.preventDefault();
        const bound = bindAsset(scene.id, assetId);
        if (!bound) return;
        selectedSceneId = bound.sceneId;
        selectedElementId = bound.elementId;
        // Binding commits through the store, so subscribers already re-rendered with the
        // previous selection; re-render here to show the element the drop actually bound.
        render(store.getProject());
        onSelectionChanged({ sceneId: selectedSceneId, elementId: selectedElementId });
        if (!bound.audio) notify('Aset diikat ke scene.', 'success');
      });
      return card;
    }));
  }

  addSceneBtn.addEventListener('click', () => {
    const sceneId = store.addScene();
    select(sceneId);
  });

  return {
    render,
    select,
    getSelection() {
      return { sceneId: selectedSceneId, elementId: selectedElementId };
    },
    moveSelected(direction) {
      if (selectedSceneId) store.moveScene(selectedSceneId, direction);
    },
    removeSelectedElement() {
      if (!selectedSceneId || !selectedElementId) return false;
      store.removeElement(selectedSceneId, selectedElementId);
      selectedElementId = null;
      onSelectionChanged({ sceneId: selectedSceneId, elementId: null });
      return true;
    },
  };
}
