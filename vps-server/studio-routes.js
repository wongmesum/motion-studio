import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  adminAuth,
  createFixedRateLimiter,
  limiter,
  requireAdminCsrf,
} from './middleware/auth.js';
import { validateJobLimits } from './middleware/limits.js';
import { enqueueRenderJob, getJobStatus, QueueUnavailableError } from './queue.js';
import { sanitizeHtml } from './security/sanitize.js';
import { logger } from './logger.js';
import { compileProject as compileStudioProject } from './studio/compile-project.js';
import {
  ProjectConflictError,
  ProjectNotFoundError,
  createProjectStore,
} from './studio/project-store.js';
import {
  AssetNotFoundError,
  createAssetStore,
} from './studio/asset-store.js';
import {
  createAssetUploadMiddleware,
  statusForError,
  toPublicAsset,
} from './studio/upload-middleware.js';
import {
  PromptUnavailableError,
  SceneAiOutputError,
  generateProjectHtml,
  generateSceneDraft,
} from './studio/scene-ai.js';
import { testRender } from './deepseek-engineer.js';
import { getServiceKeys } from './config-store.js';
import {
  buildSignedPreviewAssetUrl,
  verifyPreviewAssetRequest,
} from './studio/preview-assets.js';
import { normalizeProjectDraft } from './studio/project-schema.js';
import { createModelRegistry } from './ai/model-catalog.js';

const defaultProjectStore = createProjectStore();
const defaultModelRegistry = createModelRegistry();
const defaultAssetStore = createAssetStore();
const defaultUploadLimiter = createFixedRateLimiter({
  maxRequests: Number(process.env.RATE_LIMIT_UPLOAD_PER_MIN || 10),
});
const defaultPromptLimiter = createFixedRateLimiter({
  maxRequests: Number(process.env.RATE_LIMIT_PROMPT_PER_MIN || 5),
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATES_DIR = path.resolve(__dirname, '../render-engine/templates');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const DEFAULT_UI_ASSETS_DIR = path.resolve(__dirname, '../studio-assets');
const TEMPLATE_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.html$/;
const OUTPUT_FILE_PATTERN = /^[A-Za-z0-9_-]+\.(mp4|webm|mov)$/i;

/**
 * Builder UI assets are served through this fixed map rather than `express.static`:
 * the public surface stays a known file list, and the content type is never inferred
 * from an attacker-controlled extension.
 */
const UI_ASSET_CONTENT_TYPES = new Map([
  ['style.css', 'text/css; charset=utf-8'],
  ['icons.js', 'text/javascript; charset=utf-8'],
  ['api.js', 'text/javascript; charset=utf-8'],
  ['state.js', 'text/javascript; charset=utf-8'],
  ['prompt-panel.js', 'text/javascript; charset=utf-8'],
  ['assets-panel.js', 'text/javascript; charset=utf-8'],
  ['timeline.js', 'text/javascript; charset=utf-8'],
  ['inspector.js', 'text/javascript; charset=utf-8'],
  ['preview-frame.js', 'text/javascript; charset=utf-8'],
  ['render-panel.js', 'text/javascript; charset=utf-8'],
  ['project-utils.js', 'text/javascript; charset=utf-8'],
  ['project-library.js', 'text/javascript; charset=utf-8'],
  ['template-capabilities.js', 'text/javascript; charset=utf-8'],
  ['autosave.js', 'text/javascript; charset=utf-8'],
  ['project-io.js', 'text/javascript; charset=utf-8'],
  ['main.js', 'text/javascript; charset=utf-8'],
]);

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

function createProjectRenderPayload({ project, html, audioLocalPath, actor }) {
  return {
    template: project.template,
    duration: project.render.duration,
    fps: project.render.fps,
    width: project.render.width,
    height: project.render.height,
    codec: project.render.codec,
    html,
    // Server-only: FFmpeg muxes the track after capture, so the path never enters the
    // browser-facing HTML, project data script, or queue-visible job HTML.
    ...(audioLocalPath ? { audioLocalPath } : {}),
    // The compiler already produced sanitized, validated HTML; the engineer gate would
    // rewrite it after sanitization and could change output between preview and render.
    skipEngineer: true,
    submittedBy: actor || 'studio_admin',
  };
}

function handleProjectError(res, error) {
  if (error instanceof ProjectNotFoundError) {
    return res.status(404).json({ error: error.message });
  }
  if (error instanceof ProjectConflictError) {
    return res.status(409).json({
      error: error.message,
      currentRevision: error.currentRevision,
      project: error.currentProject,
    });
  }
  return null;
}

/**
 * Render HTML embeds `file://` URLs, so every asset id must be resolved through the
 * owner-scoped store: a foreign or expired id resolves to nothing and fails the compile
 * instead of silently pointing at another owner's file.
 */
function createRenderAssetResolver(assetStore, actor) {
  return async (assetId) => {
    const localPath = await assetStore.readPath(actor, assetId);
    if (!localPath) {
      throw new Error(`Aset tidak ditemukan atau kedaluwarsa: ${assetId}`);
    }
    return { localPath };
  };
}

function handleAssetError(res, error) {
  if (error instanceof AssetNotFoundError) {
    return res.status(404).json({ error: error.message });
  }
  return res.status(statusForError(error)).json({ error: error.message });
}

export function createStudioRouter({
  authenticate = adminAuth,
  requireCsrf = requireAdminCsrf,
  rateLimit = limiter,
  uploadLimiter = defaultUploadLimiter,
  promptLimiter = defaultPromptLimiter,
  enqueueJob = enqueueRenderJob,
  fetchJobStatus = getJobStatus,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  uiAssetsDir = DEFAULT_UI_ASSETS_DIR,
  listTemplateFiles = () => fs.readdir(templatesDir),
  readTemplate = (templateId) => fs.readFile(path.join(templatesDir, `${templateId}.html`), 'utf8'),
  projectStore = defaultProjectStore,
  compileProject = compileStudioProject,
  assetStore = defaultAssetStore,
  generateScene = generateSceneDraft,
  generateHtml = generateProjectHtml,
  testHtml = testRender,
  modelRegistry = defaultModelRegistry,
  getPreviewSecret = async () => {
    const keys = await getServiceKeys();
    return keys.hmacSecret || '';
  },
  now = () => Date.now(),
} = {}) {
  const router = express.Router();

  // Static UI modules are public by design: the shell has to render the login form before
  // a session exists, so these files must load unauthenticated. They are an explicit
  // allowlist of fixed names from a fixed directory and contain no data, only code.
  router.get('/ui/:filename', async (req, res) => {
    const { filename } = req.params;
    const contentType = UI_ASSET_CONTENT_TYPES.get(filename);
    if (!contentType) {
      return res.status(404).json({ error: 'File UI tidak ditemukan' });
    }
    const targetPath = path.resolve(uiAssetsDir, filename);
    if (path.dirname(targetPath) !== path.resolve(uiAssetsDir)) {
      return res.status(404).json({ error: 'File UI tidak ditemukan' });
    }
    try {
      await fs.access(targetPath);
    } catch {
      return res.status(404).json({ error: 'File UI tidak ditemukan' });
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(targetPath);
  });

  // Sandboxed preview frames have opaque origins and cannot use session cookies. This
  // route accepts only short-lived HMAC capabilities bound to one actor and asset id.
  router.get('/preview-assets/:id/content', async (req, res) => {
    try {
      const secret = await getPreviewSecret();
      const actor = verifyPreviewAssetRequest({
        assetId: req.params.id,
        actor: req.query.actor,
        expires: req.query.expires,
        signature: req.query.signature,
        secret,
        now: now(),
      });
      if (!actor) return res.status(404).json({ error: 'Aset tidak ditemukan' });

      const [asset, filePath] = await Promise.all([
        assetStore.get(actor, req.params.id),
        assetStore.readPath(actor, req.params.id),
      ]);
      if (!asset || !filePath) return res.status(404).json({ error: 'Aset tidak ditemukan' });

      res.setHeader('Content-Type', asset.mime);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.sendFile(filePath);
    } catch (error) {
      logger.warn('Studio preview asset unavailable', { assetId: req.params.id, error: error.message });
      return res.status(404).json({ error: 'Aset tidak ditemukan' });
    }
  });

  router.use(authenticate);

  const handleAssetUpload = createAssetUploadMiddleware({ assetStore });

  router.get('/templates', async (_req, res) => {
    try {
      const files = await listTemplateFiles();
      return res.json({ templates: projectTemplateFiles(files) });
    } catch (error) {
      logger.warn('Studio template listing failed', { error: error.message });
      return res.status(500).json({ error: 'Daftar template tidak dapat dimuat' });
    }
  });

  router.get('/models', rateLimit, async (_req, res) => {
    try {
      const payload = await modelRegistry.listProviders();
      return res.json(payload);
    } catch (error) {
      logger.warn('Model listing failed', { error: error.message });
      return res.status(500).json({ error: 'Daftar model tidak dapat dimuat' });
    }
  });

  router.post('/render', rateLimit, requireCsrf, async (req, res) => {
    try {
      let payload;
      if (req.body?.project) {
        const compiled = await compileProject(req.body.project, {
          target: 'render',
          readTemplate,
          resolveAsset: createRenderAssetResolver(assetStore, req.adminActor),
          useAiHtml: req.body.useAiHtml === true,
          generateAiHtml: generateHtml,
          testAiHtml: testHtml,
        });
        payload = createProjectRenderPayload({
          project: compiled.project,
          html: compiled.html,
          audioLocalPath: compiled.audioLocalPath,
          actor: req.adminActor,
        });
      } else {
        const templateId = validateTemplateId(req.body?.template);
        payload = createRenderPayload(req.body || {}, req.adminActor);
        payload.html = sanitizeHtml(await readTemplate(templateId));
      }
      validateJobLimits(payload);
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
      if (handleProjectError(res, error)) return undefined;
      return res.status(400).json({ error: error.message });
    }
  });

  router.post('/prompt', promptLimiter, requireCsrf, async (req, res) => {
    try {
      const providerId = req.body?.providerId;
      const model = req.body?.model;
      if (providerId) await modelRegistry.getModels(providerId);
      if (model && !(await modelRegistry.isAllowed(providerId, model))) {
        return res.status(400).json({ error: 'Model AI tidak didukung untuk provider ini' });
      }
      const result = await generateScene(req.body?.prompt, {
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof PromptUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      if (error instanceof SceneAiOutputError) {
        return res.status(422).json({ error: error.message });
      }
      return res.status(400).json({ error: error.message });
    }
  });

  router.post('/assets', uploadLimiter, requireCsrf, handleAssetUpload);

  router.get('/assets', async (req, res) => {
    try {
      const listing = await assetStore.list(req.adminActor);
      return res.json({
        ...listing,
        assets: listing.assets.map(toPublicAsset),
      });
    } catch (error) {
      logger.warn('Studio asset listing failed', { error: error.message });
      return res.status(500).json({ error: 'Daftar aset tidak dapat dimuat' });
    }
  });

  router.get('/assets/:id/content', async (req, res) => {
    try {
      const [asset, filePath] = await Promise.all([
        assetStore.get(req.adminActor, req.params.id),
        assetStore.readPath(req.adminActor, req.params.id),
      ]);
      if (!asset || !filePath) return res.status(404).json({ error: 'Aset tidak ditemukan' });

      res.setHeader('Content-Type', asset.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      if (req.query.download === '1') {
        res.attachment(asset.originalName || `${asset.assetId}${asset.extension}`);
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }
      return res.sendFile(filePath);
    } catch (error) {
      logger.warn('Studio asset content unavailable', { assetId: req.params.id, error: error.message });
      return res.status(404).json({ error: 'Aset tidak ditemukan' });
    }
  });

  router.delete('/assets/:id', requireCsrf, async (req, res) => {
    try {
      await assetStore.remove(req.adminActor, req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return handleAssetError(res, error);
    }
  });

  router.post('/projects/compile', rateLimit, requireCsrf, async (req, res) => {
    try {
      const secret = await getPreviewSecret();
      const compiled = await compileProject(req.body?.project, {
        target: 'preview',
        readTemplate,
        // Preview ownership/expiry is checked here; the URL itself carries a short-lived
        // signature because the sandboxed frame cannot send the session cookie.
        resolveAsset: createRenderAssetResolver(assetStore, req.adminActor),
        buildPreviewUrl: (assetId) => buildSignedPreviewAssetUrl({
          assetId,
          actor: req.adminActor,
          secret,
          now: now(),
        }),
        useAiHtml: req.body?.useAiHtml === true,
        generateAiHtml: generateHtml,
        testAiHtml: testHtml,
      });
      return res.json({ html: compiled.html, warnings: compiled.warnings || [] });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
        logger.warn('Studio template unavailable', { template: req.body?.project?.template, error: error.message });
        return res.status(400).json({ error: 'Template tidak tersedia' });
      }
      return res.status(400).json({ error: error.message });
    }
  });

  /**
   * Normalizes an imported JSON project without persisting it. The draft is treated as
   * untrusted: unknown fields are dropped, ids are re-minted, and the caller gets exactly
   * what the server would store. `projectId` is deliberately cleared so an import lands as
   * a fresh copy instead of silently overwriting the project it was exported from.
   */
  router.post('/projects/validate', rateLimit, requireCsrf, async (req, res) => {
    try {
      const draft = { ...(req.body?.project || {}) };
      delete draft.projectId;
      return res.json({ project: normalizeProjectDraft(draft) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post('/projects', requireCsrf, async (req, res) => {
    try {
      const created = await projectStore.create(req.adminActor, req.body?.project);
      return res.status(201).json(created);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get('/projects', async (req, res) => {
    try {
      return res.json({ projects: await projectStore.list(req.adminActor) });
    } catch (error) {
      logger.warn('Studio project listing failed', { error: error.message });
      return res.status(500).json({ error: 'Daftar project tidak dapat dimuat' });
    }
  });

  router.get('/projects/:id', async (req, res) => {
    try {
      const stored = await projectStore.get(req.adminActor, req.params.id);
      if (!stored) return res.status(404).json({ error: 'Project tidak ditemukan' });
      return res.json(stored);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.put('/projects/:id', requireCsrf, async (req, res) => {
    try {
      const updated = await projectStore.update(req.adminActor, req.params.id, {
        baseRevision: req.body?.baseRevision,
        project: req.body?.project,
      });
      return res.json(updated);
    } catch (error) {
      if (handleProjectError(res, error)) return undefined;
      return res.status(400).json({ error: error.message });
    }
  });

  router.delete('/projects/:id', requireCsrf, async (req, res) => {
    try {
      await projectStore.remove(req.adminActor, req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      if (handleProjectError(res, error)) return undefined;
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
