import { ApiError, generateScene, listAiModels } from './api.js';

const MAX_PROMPT_CHARS = 4000;
const MODEL_STORAGE_KEY = 'motionStudio.ai.model.v1';
const FALLBACK_PROVIDERS = [
  {
    id: 'river',
    label: 'River AI',
    defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
    models: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash', label: 'DeepSeek V4.1 Flash' }],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Official',
    defaultModel: 'deepseek-chat',
    models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
  },
];

function createOption(doc, value, label) {
  const option = doc.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function readStoredSelection() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) || 'null');
    if (typeof parsed?.providerId !== 'string' || typeof parsed?.model !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSelection(providerId, model) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ providerId, model }));
  } catch {
    // Selection persistence is optional; generation still works with browser storage blocked.
  }
}

/**
 * Prompt composer. AI output stays a proposal merged as editable scene data; the browser
 * sends provider/model ids only, while credentials remain server-side.
 */
export function createPromptPanel({ document: doc, onGenerated, notify, isBusy }) {
  const textarea = doc.getElementById('promptInput');
  const counter = doc.getElementById('promptCount');
  const providerSelect = doc.getElementById('providerSelect');
  const modelSelect = doc.getElementById('modelSelect');
  const generateBtn = doc.getElementById('generateBtn');
  const choice = doc.getElementById('promptChoice');
  const replaceBtn = doc.getElementById('promptReplaceBtn');
  const appendBtn = doc.getElementById('promptAppendBtn');
  const cancelBtn = doc.getElementById('promptCancelBtn');

  let pendingResult = null;
  let providers = FALLBACK_PROVIDERS;

  function refreshCounter() {
    counter.textContent = `${textarea.value.length} / ${MAX_PROMPT_CHARS}`;
  }

  function setBusy(busy) {
    generateBtn.disabled = busy;
    generateBtn.textContent = busy ? 'Menyusun scene…' : 'Buat Struktur Scene';
  }

  function showChoice(result) {
    pendingResult = result;
    choice.hidden = false;
    generateBtn.disabled = true;
    generateBtn.textContent = 'Struktur scene siap';
  }

  function hideChoice() {
    pendingResult = null;
    choice.hidden = true;
    setBusy(false);
  }

  function currentProvider() {
    return providers.find((provider) => provider.id === providerSelect.value) || providers[0];
  }

  function populateModels(preferredModel = '') {
    const provider = currentProvider();
    const models = provider?.models || [];
    modelSelect.replaceChildren(...models.map((model) =>
      createOption(doc, model.id, model.label || model.id)
    ));
    const desiredModel = models.some((model) => model.id === preferredModel)
      ? preferredModel
      : provider?.defaultModel;
    if (desiredModel && models.some((model) => model.id === desiredModel)) {
      modelSelect.value = desiredModel;
    }
    modelSelect.disabled = models.length === 0;
  }

  function populateProviders(preferredSelection) {
    providerSelect.replaceChildren(...providers.map((provider) =>
      createOption(doc, provider.id, provider.label || provider.id)
    ));
    const preferredProvider = providers.some(
      (provider) => provider.id === preferredSelection?.providerId
    ) ? preferredSelection.providerId : providers[0]?.id;
    if (preferredProvider) providerSelect.value = preferredProvider;
    populateModels(preferredSelection?.model || '');
  }

  async function loadModels() {
    const stored = readStoredSelection();
    try {
      const result = await listAiModels();
      if (Array.isArray(result?.providers) && result.providers.length > 0) {
        providers = result.providers.filter(
          (provider) => typeof provider?.id === 'string' && Array.isArray(provider.models)
        );
      }
    } catch (error) {
      // Static fallback keeps the scene prompt usable during model discovery/list outages.
      providers = FALLBACK_PROVIDERS;
      if (!(error instanceof ApiError && error.status === 401)) {
        notify('Daftar model tidak dapat dimuat. Model bawaan digunakan.', 'error');
      }
    }
    populateProviders(stored);
  }

  function persistSelection() {
    if (!providerSelect.value || !modelSelect.value) return;
    saveSelection(providerSelect.value, modelSelect.value);
  }

  function apply(mode) {
    if (!pendingResult) return;
    const result = pendingResult;
    hideChoice();
    onGenerated({ ...result, mode });
    notify(mode === 'append' ? 'Scene ditambahkan ke timeline.' : 'Scene diganti.', 'success');
  }

  async function generate() {
    const prompt = textarea.value.trim();
    if (!prompt) {
      notify('Tulis prompt terlebih dahulu.', 'error');
      textarea.focus();
      return;
    }
    if (isBusy()) return;

    setBusy(true);
    try {
      persistSelection();
      const result = await generateScene(prompt, providerSelect.value, modelSelect.value);
      showChoice(result);
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        notify('Provider AI belum dikonfigurasi. Periksa API key di server.', 'error');
      } else {
        notify(error.message || 'Gagal membuat struktur scene.', 'error');
      }
      setBusy(false);
    }
  }

  textarea.addEventListener('input', refreshCounter);
  providerSelect.addEventListener('change', () => {
    populateModels();
    persistSelection();
  });
  modelSelect.addEventListener('change', persistSelection);
  generateBtn.addEventListener('click', generate);
  replaceBtn.addEventListener('click', () => apply('replace'));
  appendBtn.addEventListener('click', () => apply('append'));
  cancelBtn.addEventListener('click', hideChoice);

  return {
    async init() {
      refreshCounter();
      hideChoice();
      await loadModels();
    },
    setPrompt(value) {
      textarea.value = value.slice(0, MAX_PROMPT_CHARS);
      refreshCounter();
    },
  };
}
