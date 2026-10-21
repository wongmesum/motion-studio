import { ApiError, fetchJob, submitRender } from './api.js';
import { MAX_RENDER_DURATION_SEC, sumSceneDurations } from './project-utils.js';

const STATUS_LABELS = {
  queued: 'Dalam antrean',
  waiting: 'Menunggu worker',
  waiting_children: 'Menunggu worker',
  delayed: 'Dalam antrean',
  active: 'Sedang dirender',
  processing: 'Sedang dirender',
  completed: 'Selesai',
  failed: 'Gagal',
};

function describeJob(job) {
  const raw = job.progress;
  const record = typeof raw === 'object' && raw !== null ? raw : {};
  const percent = typeof raw === 'number' ? raw : Number(record.progress ?? 0);
  const renderedFrames = record.renderedFrames;
  const totalFrames = record.totalFrames;
  const suffix = renderedFrames ? ` (${renderedFrames}/${totalFrames} frame)` : '';
  return {
    percent,
    label: `${STATUS_LABELS[job.status] || job.status}${suffix}`,
    terminal: job.status === 'completed' || job.status === 'failed',
  };
}

function getDownloadUrl(url) {
  if (url.startsWith('/api/studio/output/')) {
    return url.includes('?') ? `${url}&download=1` : `${url}?download=1`;
  }
  return url;
}

/** Builder render: submits the compiled project and polls the job to completion. */
export function createRenderPanel({ document: doc, store, notify }) {
  const statusEl = doc.getElementById('renderStatus');
  const progressFill = doc.getElementById('renderProgress');
  const progressText = doc.getElementById('renderProgressText');
  const jobId = doc.getElementById('renderJobId');
  const result = doc.getElementById('renderResult');
  const video = doc.getElementById('renderVideo');
  const download = doc.getElementById('downloadVideo');
  const submitBtn = doc.getElementById('renderSubmitBtn');
  const durationInput = doc.getElementById('renderDuration');
  const fpsSelect = doc.getElementById('renderFps');
  const resolutionSelect = doc.getElementById('renderResolution');
  const codecSelect = doc.getElementById('renderCodec');
  const useAiHtml = doc.getElementById('useAiHtml');

  let pollTimer = null;
  let activeJobId = '';

  function setState(state) {
    statusEl.dataset.state = state;
  }

  function setProgress(percent) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    progressFill.style.width = `${value}%`;
    progressText.textContent = `${value}%`;
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function applySettingsToProject() {
    const [width, height] = resolutionSelect.value.split('x').map(Number);
    store.update((project) => ({
      ...project,
      render: {
        ...project.render,
        // Duration stays derived from the scene timeline; only the encoding options are
        // authored here.
        duration: sumSceneDurations(project),
        fps: Number(fpsSelect.value),
        width,
        height,
        codec: codecSelect.value,
      },
    }));
  }

  async function poll() {
    let job;
    try {
      job = await fetchJob(activeJobId);
    } catch (error) {
      stopPolling();
      submitBtn.disabled = false;
      setState('error');
      notify(error.message || 'Status job tidak tersedia.', 'error');
      return;
    }
    const described = describeJob(job);
    setProgress(described.percent);
    statusEl.textContent = described.label;
    setState(job.status === 'completed' ? 'done' : job.status === 'failed' ? 'error' : 'active');

    if (!described.terminal) return;
    stopPolling();
    submitBtn.disabled = false;

    if (job.status === 'failed') {
      notify(`Render gagal: ${job.error || 'tanpa detail'}`, 'error');
      return;
    }
    if (job.result?.url) {
      video.src = job.result.url;
      download.href = getDownloadUrl(job.result.url);
      result.hidden = false;
    }
  }

  submitBtn.addEventListener('click', async () => {
    applySettingsToProject();
    const project = store.getProject();
    if (!project.scenes?.length) {
      notify('Tambahkan minimal satu scene sebelum render.', 'error');
      return;
    }
    const totalDuration = sumSceneDurations(project);
    if (totalDuration > MAX_RENDER_DURATION_SEC) {
      notify(
        `Total durasi scene ${totalDuration} detik melebihi batas ${MAX_RENDER_DURATION_SEC} detik.`,
        'error'
      );
      return;
    }

    stopPolling();
    submitBtn.disabled = true;
    result.hidden = true;
    video.removeAttribute('src');
    setProgress(0);
    statusEl.textContent = 'Mengirim…';
    setState('active');

    try {
      const body = await submitRender(project, { useAiHtml: useAiHtml.checked });
      activeJobId = body.job_id;
      jobId.textContent = `Job ${activeJobId}`;
      pollTimer = setInterval(poll, 1000);
      poll();
    } catch (error) {
      submitBtn.disabled = false;
      setState('error');
      statusEl.textContent = 'Gagal dikirim';
      notify(error instanceof ApiError ? error.message : 'Render gagal dikirim.', 'error');
    }
  });

  return {
    stopPolling,
  };
}
