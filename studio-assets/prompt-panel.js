import { ApiError, generateScene } from './api.js';

const MAX_PROMPT_CHARS = 4000;

/**
 * Prompt composer. The AI result is only ever a proposal: it is merged into the editable
 * project as scene data, never rendered directly, so a bad generation is always recoverable
 * with undo.
 */
export function createPromptPanel({ document: doc, onGenerated, notify, isBusy }) {
  const textarea = doc.getElementById('promptInput');
  const counter = doc.getElementById('promptCount');
  const providerSelect = doc.getElementById('providerSelect');
  const generateBtn = doc.getElementById('generateBtn');
  const choice = doc.getElementById('promptChoice');
  const replaceBtn = doc.getElementById('promptReplaceBtn');
  const appendBtn = doc.getElementById('promptAppendBtn');
  const cancelBtn = doc.getElementById('promptCancelBtn');

  let pendingResult = null;

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
      const result = await generateScene(prompt, providerSelect.value);
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
  generateBtn.addEventListener('click', generate);
  replaceBtn.addEventListener('click', () => apply('replace'));
  appendBtn.addEventListener('click', () => apply('append'));
  cancelBtn.addEventListener('click', hideChoice);

  return {
    init() {
      refreshCounter();
      hideChoice();
    },
    setPrompt(value) {
      textarea.value = value.slice(0, MAX_PROMPT_CHARS);
      refreshCounter();
    },
  };
}
