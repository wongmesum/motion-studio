import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { adminAuth, limiter, requireAdminCsrf } from './middleware/auth.js';
import { validateJobLimits } from './middleware/limits.js';
import { enqueueRenderJob, getJobStatus, QueueUnavailableError } from './queue.js';
import { sanitizeHtml } from './security/sanitize.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATES_DIR = path.resolve(__dirname, '../render-engine/templates');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const TEMPLATE_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.html$/;
const OUTPUT_FILE_PATTERN = /^[A-Za-z0-9_-]+\.(mp4|webm|mov)$/i;

function formatTemplateLabel(templateId) {
  return templateId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function projectTemplateFiles(files) {
  return files
    .filter((filename) => TEMPLATE_FILE_PATTERN.test(filename))
    .sort()
    .map((filename) => {
      const id = filename.slice(0, -'.html'.length);
      return { id, label: formatTemplateLabel(id) };
    });
}

function getLocalOutputFilename(result) {
  if (typeof result?.localPath === 'string') return path.basename(result.localPath);
  if (result?.storage !== 'local_disk' || typeof result?.url !== 'string') return null;
  try {
    return path.basename(new URL(result.url).pathname);
  } catch {
    return null;
  }
}

function projectStudioResult(result) {
  if (!result || typeof result !== 'object') return null;
  const localFilename = getLocalOutputFilename(result);
  const projected = {
    url: localFilename
      ? `/api/studio/output/${encodeURIComponent(localFilename)}`
      : result.url,
    storage: result.storage,
    cached: result.cached,
    render_time_seconds: result.render_time_seconds,
  };
  return Object.fromEntries(Object.entries(projected).filter(([, value]) => value !== undefined));
}

const STUDIO_PROGRESS_FIELDS = [
  'status',
  'progress',
  'percent',
  'renderedFrames',
  'totalFrames',
  'cached',
];

function selectStudioProgressFields(progress) {
  return Object.fromEntries(
    STUDIO_PROGRESS_FIELDS
      .filter((field) => progress[field] !== undefined)
      .map((field) => [field, progress[field]])
  );
}

/**
 * BullMQ stores renderer updates as `job.progress`, including the final result object.
 * The in-memory queue instead spreads updates onto the job record. Select telemetry
 * explicitly so both backends expose one safe shape without leaking internal reports.
 */
function projectStudioProgress(job) {
  const raw = job.progress;
  const fromQueue = typeof raw === 'object' && raw !== null
    ? selectStudioProgressFields(raw)
    : { progress: raw ?? 0 };
  return {
    ...fromQueue,
    ...(job.renderedFrames !== undefined ? { renderedFrames: job.renderedFrames } : {}),
    ...(job.totalFrames !== undefined ? { totalFrames: job.totalFrames } : {}),
  };
}

export function projectStudioJob(job) {
  return {
    job_id: String(job.job_id ?? job.id ?? ''),
    status: String(job.status ?? 'unknown'),
    progress: projectStudioProgress(job),
    error: job.error ? String(job.error) : null,
    result: projectStudioResult(job.result),
  };
}

function validateTemplateId(template) {
  if (typeof template !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(template)) {
    throw new Error('Template tidak valid');
  }
  return template;
}

function createRenderPayload(body, actor) {
  return {
    template: body.template,
    duration: body.duration,
    fps: body.fps,
    width: body.width,
    height: body.height,
    codec: body.codec,
    ...(body.audio_url ? { audio_url: body.audio_url } : {}),
    submittedBy: actor || 'studio_admin',
  };
}

export function createStudioRouter({
  authenticate = adminAuth,
  requireCsrf = requireAdminCsrf,
  rateLimit = limiter,
  enqueueJob = enqueueRenderJob,
  fetchJobStatus = getJobStatus,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  listTemplateFiles = () => fs.readdir(templatesDir),
  readTemplate = (templateId) => fs.readFile(path.join(templatesDir, `${templateId}.html`), 'utf8'),
} = {}) {
  const router = express.Router();
  router.use(authenticate);

  router.get('/templates', async (_req, res) => {
    try {
      const files = await listTemplateFiles();
      return res.json({ templates: projectTemplateFiles(files) });
    } catch (error) {
      logger.warn('Studio template listing failed', { error: error.message });
      return res.status(500).json({ error: 'Daftar template tidak dapat dimuat' });
    }
  });

  router.post('/render', rateLimit, requireCsrf, async (req, res) => {
    try {
      const templateId = validateTemplateId(req.body?.template);
      const payload = createRenderPayload(req.body || {}, req.adminActor);
      validateJobLimits(payload);
      payload.html = sanitizeHtml(await readTemplate(templateId));
      const queued = await enqueueJob(payload);
      return res.status(202).json(queued);
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        logger.warn('Studio render submission rejected: queue unavailable', { error: error.message });
        return res.status(503).json({ error: 'Layanan antrean sedang tidak tersedia' });
      }
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
        logger.warn('Studio template unavailable', { template: req.body?.template, error: error.message });
        return res.status(400).json({ error: 'Template tidak tersedia' });
      }
      return res.status(400).json({ error: error.message });
    }
  });

  router.get('/jobs/:id', async (req, res) => {
    try {
      const job = await fetchJobStatus(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });
      return res.json(projectStudioJob(job));
    } catch (error) {
      logger.warn('Studio job status unavailable', { jobId: req.params.id, error: error.message });
      return res.status(503).json({ error: 'Layanan antrean sedang tidak tersedia' });
    }
  });

  router.get('/output/:filename', async (req, res) => {
    const { filename } = req.params;
    if (!OUTPUT_FILE_PATTERN.test(filename)) {
      return res.status(400).json({ error: 'Nama file output tidak valid' });
    }
    const targetPath = path.resolve(outputDir, filename);
    if (!targetPath.startsWith(path.resolve(outputDir) + path.sep)) {
      return res.status(400).json({ error: 'Path output tidak valid' });
    }
    try {
      await fs.access(targetPath);
    } catch {
      return res.status(404).json({ error: 'File render tidak ditemukan' });
    }
    if (req.query.download === '1') res.attachment(filename);
    return res.sendFile(targetPath);
  });

  return router;
}
