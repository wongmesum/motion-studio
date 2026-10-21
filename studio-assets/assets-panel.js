import { assetContentUrl, deleteAsset, listAssets, uploadAsset } from './api.js';
import { iconMarkup, setButtonIcon } from './icons.js';

const TYPE_LABELS = { image: 'Gambar', video: 'Video', audio: 'Audio' };

/**
 * Asset library: upload via drag-and-drop or file picker, list owner assets, and delete.
 * The panel keeps a live `assetId -> asset` map so the inspector can bind elements to a
 * library entry by opaque id (never by the client-supplied filename).
 */
export function createAssetsPanel({ document: doc, notify, onAssetsChanged }) {
  const dropZone = doc.getElementById('assetDropZone');
  const fileInput = doc.getElementById('assetFileInput');
  const grid = doc.getElementById('assetGrid');
  const usage = doc.getElementById('assetUsage');
  const refreshBtn = doc.getElementById('refreshAssetsBtn');

  let assets = [];

  function renderUsage() {
    const count = assets.length;
    const bytes = assets.reduce((total, asset) => total + (Number(asset.bytes) || 0), 0);
    const megabytes = bytes / (1024 * 1024);
    usage.textContent = `${count} aset • ${megabytes.toFixed(1)} MB`;
  }

  function kindOf(asset) {
    if (asset.mime?.startsWith('image/')) return 'image';
    if (asset.mime?.startsWith('video/')) return 'video';
    return 'audio';
  }

  function renderGrid() {
    if (assets.length === 0) {
      grid.innerHTML = '<p class="empty-copy">Belum ada aset. Tarik file ke area di atas.</p>';
      renderUsage();
      return;
    }
    grid.replaceChildren(...assets.map((asset) => {
      const card = doc.createElement('div');
      card.className = 'asset-card';
      card.draggable = true;
      card.dataset.assetId = asset.assetId;

      const kind = kindOf(asset);
      const media = kind === 'audio'
        ? doc.createElement('div')
        : doc.createElement(kind === 'image' ? 'img' : 'video');
      if (kind === 'audio') {
        media.className = 'asset-icon';
        media.innerHTML = iconMarkup('audio');
      } else {
        media.src = assetContentUrl(asset.assetId);
        if (kind === 'video') media.muted = true;
        media.alt = asset.originalName || 'Aset';
      }
      media.draggable = false;

      const label = doc.createElement('span');
      label.className = 'asset-label';
      label.textContent = asset.originalName || asset.assetId;

      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'asset-remove';
      setButtonIcon(remove, 'close');
      remove.setAttribute('aria-label', `Hapus ${asset.originalName || 'aset'}`);
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        await removeAsset(asset);
      });

      card.append(media, label, remove);
      card.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', asset.assetId);
        event.dataTransfer.effectAllowed = 'copy';
      });
      return card;
    }));
    renderUsage();
  }

  async function removeAsset(asset) {
    const confirmed = window.confirm(`Hapus "${asset.originalName || asset.assetId}"?`);
    if (!confirmed) return;
    try {
      await deleteAsset(asset.assetId);
      assets = assets.filter((item) => item.assetId !== asset.assetId);
      renderGrid();
      onAssetsChanged(assets);
      notify('Aset dihapus.', 'success');
    } catch (error) {
      notify(error.message || 'Gagal menghapus aset.', 'error');
    }
  }

  async function refresh() {
    try {
      const listing = await listAssets();
      assets = listing.assets || [];
      renderGrid();
      onAssetsChanged(assets);
    } catch (error) {
      notify(error.message || 'Gagal memuat aset.', 'error');
    }
  }

  async function uploadFiles(files) {
    for (const file of files) {
      const card = doc.createElement('div');
      card.className = 'asset-card is-busy';
      card.textContent = TYPE_LABELS[kindFromFile(file)] || 'Aset';
      grid.prepend(card);
      try {
        await uploadAsset(file, {
          onProgress: (ratio) => {
            card.textContent = `${Math.round(ratio * 100)}%`;
          },
        });
        notify(`"${file.name}" diunggah.`, 'success');
      } catch (error) {
        notify(error.message || `Gagal mengunggah "${file.name}".`, 'error');
      } finally {
        card.remove();
      }
    }
    await refresh();
  }

  function kindFromFile(file) {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    return 'audio';
  }

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) uploadFiles([...fileInput.files]);
    fileInput.value = '';
  });

  for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add('is-dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove('is-dragging');
    });
  }
  dropZone.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) uploadFiles(files);
  });

  refreshBtn.addEventListener('click', refresh);

  return {
    init() {
      return refresh();
    },
    getAssets() {
      return assets;
    },
    getAsset(assetId) {
      return assets.find((asset) => asset.assetId === assetId) || null;
    },
  };
}
