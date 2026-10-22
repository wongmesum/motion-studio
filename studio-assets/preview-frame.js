import { ApiError, compileProject } from './api.js';
import { setButtonIcon } from './icons.js';
import { sumSceneDurations } from './project-utils.js';

const COMPILE_DEBOUNCE_MS = 350;
const TOTAL_TIME_MS = 1000;

/**
 * Compiled preview.
 *
 * The frame loads the same HTML the renderer will use (`compileProject` with the `preview`
 * target), so what the author sees cannot drift from the produced video. Nothing is
 * re-implemented in canvas here, and a failed compile shows a message instead of a fake stage.
 */
export function createPreviewFrame({
  document: doc,
  store,
  projectIssues,
  notify,
  getUseAiHtml = () => false,
}) {
  const stage = doc.getElementById('previewStage');
  const frame = doc.getElementById('previewFrame');
  const placeholder = doc.getElementById('previewPlaceholder');
  const loading = doc.getElementById('previewLoading');
  const status = doc.getElementById('previewStatus');
  const playBtn = doc.getElementById('previewPlayBtn');
  const timeSlider = doc.getElementById('previewTime');
  const timeLabel = doc.getElementById('previewTimeLabel');
  const refreshBtn = doc.getElementById('refreshPreviewBtn');
  setButtonIcon(playBtn, 'play');

  let controller = null;
  let debounceTimer = null;
  let playing = false;
  let animationHandle = null;
  let durationSec = 10;
  let lastFrameAt = 0;
  let currentTime = 0;

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.style.color = isError ? 'var(--rose)' : '';
  }

  function formatTime(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return `00:${String(whole).padStart(2, '0')}`;
  }

  function updateTimeLabel() {
    timeLabel.textContent = `${formatTime(currentTime)} / ${formatTime(durationSec)}`;
    timeSlider.value = String(Math.round((currentTime / Math.max(durationSec, 0.1)) * TOTAL_TIME_MS));
  }

  function postFrame() {
    // The frame has no `allow-same-origin`, so it has an opaque origin and the parent
    // cannot call into it. Frames are driven through a one-way message.
    const target = frame.contentWindow;
    if (!target) return;
    target.postMessage(
      { type: 'motion-preview-frame', time: currentTime },
      '*'
    );
  }

  function stopPlayback() {
    playing = false;
    setButtonIcon(playBtn, 'play');
    playBtn.setAttribute('aria-label', 'Putar preview');
    if (animationHandle) cancelAnimationFrame(animationHandle);
    animationHandle = null;
  }

  function tick(now) {
    if (!playing) return;
    if (now - lastFrameAt >= 40) {
      currentTime = (currentTime + (now - lastFrameAt) / 1000) % Math.max(durationSec, 0.1);
      lastFrameAt = now;
      updateTimeLabel();
      postFrame();
    }
    animationHandle = requestAnimationFrame(tick);
  }

  frame.addEventListener('load', () => {
    // The compiled document is static; the parent drives its deterministic renderFrame.
    updateTimeLabel();
    postFrame();
    if (playing) {
      lastFrameAt = performance.now();
      animationHandle = requestAnimationFrame(tick);
    }
  });

  async function compile() {
    const project = store.getProject();
    const width = Number(project.render?.width);
    const height = Number(project.render?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      stage.style.aspectRatio = width + ' / ' + height;
      stage.classList.toggle('portrait', width < height);
    }
    const issues = projectIssues(project);
    if (issues.length > 0) {
      frame.removeAttribute('srcdoc');
      placeholder.hidden = false;
      setStatus(issues[0], true);
      return;
    }

    if (controller) controller.abort();
    controller = new AbortController();
    loading.hidden = false;
    setStatus('Menyusun preview…');

    try {
      const result = await compileProject(project, {
        useAiHtml: getUseAiHtml(),
        signal: controller.signal,
      });
      durationSec = sumSceneDurations(project);
      currentTime = Math.min(currentTime, durationSec);
      frame.srcdoc = result.html;
      placeholder.hidden = true;
      const warnings = result.warnings || [];
      setStatus(
        warnings.length ? `Preview siap dengan catatan: ${warnings[0]}` : 'Preview siap',
        warnings.length > 0
      );
    } catch (error) {
      if (error?.name === 'AbortError') return;
      placeholder.hidden = false;
      setStatus(error instanceof ApiError ? error.message : 'Preview gagal dibuat.', true);
      if (!(error instanceof ApiError)) notify('Preview gagal dibuat.', 'error');
    } finally {
      loading.hidden = true;
    }
  }

  function scheduleCompile() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(compile, COMPILE_DEBOUNCE_MS);
  }

  playBtn.addEventListener('click', () => {
    playing = !playing;
    setButtonIcon(playBtn, playing ? 'pause' : 'play');
    playBtn.setAttribute('aria-label', playing ? 'Jeda preview' : 'Putar preview');
    if (playing) {
      lastFrameAt = performance.now();
      animationHandle = requestAnimationFrame(tick);
    } else {
      stopPlayback();
    }
  });

  timeSlider.addEventListener('input', () => {
    stopPlayback();
    currentTime = (Number(timeSlider.value) / TOTAL_TIME_MS) * Math.max(durationSec, 0.1);
    updateTimeLabel();
    postFrame();
  });

  refreshBtn.addEventListener('click', compile);

  return {
    compile,
    scheduleCompile,
    stopPlayback,
    updateTimeLabel,
  };
}
