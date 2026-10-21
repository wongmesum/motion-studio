import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { auth, adminAuth, limiter, requireAdminCsrf, verifySignature } from './middleware/auth.js';
import { createSessionRouter } from './session-routes.js';
import { createStudioRouter } from './studio-routes.js';
import { validateJobLimits } from './middleware/limits.js';
import { sanitizeHtml } from './security/sanitize.js';
import { validateAiTestInput } from './security/ai-test-input.js';
import {
  initQueue,
  enqueueRenderJob,
  getJobStatus,
  getQueueStats,
  isQueueHealthy,
  QueueUnavailableError,
} from './queue.js';
import {
  validate as deepseekValidate,
  optimize as deepseekOptimize,
  callAiChat,
  buildAiCurlCommand,
  buildAiCompletionsUrl,
  hasRiverApiKey,
} from './deepseek-engineer.js';
import {
  initConfigStore,
  getAiConfig,
  projectPublicAiConfig,
  updateApiKeysConfig,
  addKeyToVault,
  activateVaultKey,
  deleteVaultKey,
  listUsers,
  createUser,
  updateUser,
  regenerateUserToken,
  deleteUser,
  addAuditLog,
  generateConversationId,
  projectPublicKey,
  projectPublicRiverConfig,
  projectPublicServiceKeys,
  projectPublicUser,
} from './config-store.js';
import { startCleanupScheduler } from './cleanup.js';
import { logger, formatPrometheusMetrics } from './logger.js';
import { createModelRegistry } from './ai/model-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
// Production has exactly one local Nginx hop. This makes req.ip represent the remote
// client for login rate limiting without trusting arbitrary forwarded headers directly.
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const modelRegistry = createModelRegistry();

const configuredCorsOrigins = new Set(
  String(process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && configuredCorsOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Token, X-Admin-Token, X-Signature, X-River-Conversation-Id'
  );
  if (req.method === 'OPTIONS') {
    return origin && configuredCorsOrigins.has(origin)
      ? res.sendStatus(204)
      : res.status(403).json({ error: 'CORS origin not allowed' });
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use('/api/session', createSessionRouter());
app.use('/api/studio', createStudioRouter());

// ============================================================
// STATIC UI ROUTES (Admin Dashboard & Preview Studio)
// ============================================================
app.get('/', (_req, res) => {
  res.redirect('/studio');
});

app.get('/admin', async (_req, res) => {
  const adminHtmlPath = path.resolve(__dirname, '../admin-dashboard.html');
  res.sendFile(adminHtmlPath);
});

app.get('/studio', async (_req, res) => {
  const studioHtmlPath = path.resolve(__dirname, '../preview-studio.html');
  res.sendFile(studioHtmlPath);
});

// ============================================================
// PUBLIC HEALTH & METRICS ENDPOINTS
// ============================================================
// Liveness proves the HTTP process can answer. Readiness below also checks Redis and may
// return 503; restart automation must use liveness so a dependency outage does not create
// a container restart loop that drops in-memory fallback jobs.
app.get('/live', (_req, res) => {
  res.json({ status: 'alive' });
});

app.get('/health', async (_req, res) => {
  const stats = await getQueueStats();
  const aiConfig = await getAiConfig();
  const cpuLoad = os.loadavg()[0] || 0;
  const healthy = isQueueHealthy(stats);
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    cpuLoad,
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
    aiProvider: {
      providerId: aiConfig.providerId,
      provider: aiConfig.provider,
      model: aiConfig.model,
      baseUrl: aiConfig.baseUrl,
      keyConfigured: await hasRiverApiKey(undefined, aiConfig.providerId),
    },
    queue: stats,
  });
});

app.get('/metrics', async (_req, res) => {
  const stats = await getQueueStats();
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(formatPrometheusMetrics(stats.waiting));
});

// ============================================================
// ADMIN DASHBOARD API ENDPOINTS (/api/admin/*)
// Adds the derived endpoint and cURL sample the dashboard renders, on top of the
// masked projection. Never includes the raw API key.
function projectProviderDetail(providerId, config) {
  return {
    ...projectPublicRiverConfig(config),
    providerId,
    endpoint: buildAiCompletionsUrl(config.baseUrl),
    curlExample: buildAiCurlCommand(providerId, {
      baseUrl: config.baseUrl,
      model: config.model,
      stream: config.stream,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      enableThinking: config.chatTemplateKwargs?.enable_thinking,
    }),
  };
}

app.get('/api/admin/overview', adminAuth, async (_req, res) => {
  try {
    const store = await initConfigStore();
    const queueStats = await getQueueStats();
    const activeUsers = store.users.filter((u) => u.status === 'active').length;
    const totalQuotaUsed = store.users.reduce((acc, u) => acc + (u.quotaUsed || 0), 0);
    const totalRiverRequests = store.keyVault.reduce((acc, k) => acc + (k.requestsCount || 0), 0);

    res.json({
      activeAiProvider: store.activeAiProvider,
      aiProviders: projectPublicAiConfig(store).providers,
      activeProviderConfig: projectProviderDetail(
        store.activeAiProvider,
        store.aiProviders[store.activeAiProvider]
      ),
      riverConfig: projectProviderDetail('river', store.aiProviders.river),
      serviceKeys: projectPublicServiceKeys(store.serviceKeys),
      stats: {
        totalUsers: store.users.length,
        activeUsers,
        suspendedUsers: store.users.length - activeUsers,
        totalQuotaUsed,
        totalRiverRequests,
        vaultKeysCount: store.keyVault.length,
        queue: queueStats,
        freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      },
      keyVault: store.keyVault.map(projectPublicKey),
      users: store.users.map(projectPublicUser),
      auditLogs: store.auditLogs.slice(0, 50),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ambil & Update Konfigurasi AI Provider + Service Keys
app.get('/api/admin/keys', adminAuth, async (_req, res) => {
  const store = await initConfigStore();
  res.json({
    activeAiProvider: store.activeAiProvider,
    aiProviders: projectPublicAiConfig(store).providers,
    riverConfig: projectPublicRiverConfig(store.aiProviders.river),
    serviceKeys: projectPublicServiceKeys(store.serviceKeys),
    keyVault: store.keyVault.map(projectPublicKey),
  });
});

app.put('/api/admin/keys', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    const updated = await updateApiKeysConfig(req.body, req.adminActor);
    res.json({
      ok: true,
      message: 'Konfigurasi AI provider dan service berhasil disimpan',
      activeAiProvider: updated.activeAiProvider,
      aiProviders: projectPublicAiConfig(updated).providers,
      riverConfig: projectPublicRiverConfig(updated.aiProviders.river),
      serviceKeys: projectPublicServiceKeys(updated.serviceKeys),
      keyVault: updated.keyVault.map(projectPublicKey),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manajemen AI Key Vault (Tambah, Aktifkan, Hapus Key per provider)
app.post('/api/admin/keys/vault', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    const added = await addKeyToVault(req.body, req.adminActor);
    res.status(201).json({ ok: true, key: projectPublicKey(added) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/keys/vault/:id/activate', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    const activated = await activateVaultKey(req.params.id, req.adminActor);
    res.json({ ok: true, key: projectPublicKey(activated) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/keys/vault/:id', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    const removed = await deleteVaultKey(req.params.id, req.adminActor);
    res.json({ ok: true, removed: projectPublicKey(removed) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The prompt never leaves the server, so echo back the request shape with content redacted.
function redactRequestBody(requestBody = {}) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  return {
    ...requestBody,
    messages: messages.map((message) => ({ ...message, content: '[REDACTED]' })),
  };
}

async function testAiProvider(req, res, forcedProviderId) {
  let input;
  try {
    input = validateAiTestInput(req.body || {}, forcedProviderId || null);
  } catch (validationError) {
    return res.status(400).json({ error: validationError.message });
  }

  const config = await getAiConfig(input.providerId);
  const conversationId = input.conversationId || generateConversationId();

  try {
    const result = await callAiChat({
      providerId: config.providerId,
      messages: [{ role: 'user', content: input.prompt }],
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      enableThinking: input.enableThinking,
      stream: input.stream,
      conversationId,
    });
    await addAuditLog(
      req.adminActor,
      'AI_PROVIDER_TEST_SUCCESS',
      `Tested ${config.provider} model ${result.model} (${result.latencyMs}ms)`
    );
    return res.json({
      ok: true,
      mode: 'live_ai_api',
      providerId: config.providerId,
      conversationId: result.conversationId,
      model: result.model,
      endpoint: result.endpoint,
      latencyMs: result.latencyMs,
      content: result.content,
      requestBody: redactRequestBody(result.requestBody),
    });
  } catch (error) {
    logger.warn('AI provider test failed', { providerId: config.providerId, error: error.message });
    return res.status(502).json({
      ok: false,
      error: 'Uji koneksi provider AI gagal',
      providerId: config.providerId,
      conversationId,
      model: config.model,
      endpoint: buildAiCompletionsUrl(config.baseUrl),
    });
  }
}

app.post('/api/admin/ai/test', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    return await testAiProvider(req, res);
  } catch (error) {
    logger.warn('AI provider test setup failed', { error: error.message });
    return res.status(400).json({ error: 'Konfigurasi provider AI tidak valid' });
  }
});

// Compatibility route for existing River dashboard clients.
app.post('/api/admin/river/test', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    return await testAiProvider(req, res, 'river');
  } catch (error) {
    logger.warn('River compatibility test setup failed', { error: error.message });
    return res.status(400).json({ error: 'Konfigurasi River AI tidak valid' });
  }
});

/**
 * Admin-triggered live refresh of the model catalog. Discovery is best-effort: a provider
 * that has no `/models` endpoint (or refuses the request) simply contributes nothing, and
 * the static catalog keeps serving. The response carries ids only — never the API key.
 */
app.post('/api/admin/ai/models/refresh', adminAuth, requireAdminCsrf, async (_req, res) => {
  const discovered = {};
  for (const providerId of ['river', 'deepseek']) {
    discovered[providerId] = (await modelRegistry.discover(providerId)).map((id) => ({ id }));
  }
  res.json({ ok: true, discovered });
});

// Manajemen User (List, Create, Update, Rotate Token, Delete)
app.get('/api/admin/users', adminAuth, async (_req, res) => {
  const users = await listUsers();
  res.json({ users: users.map(projectPublicUser) });
});

app.post('/api/admin/users', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    const user = await createUser(req.body, req.adminActor);
    res.status(201).json({
      ok: true,
      user: projectPublicUser(user),
      oneTimeApiToken: user.apiToken,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/users/:id', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    const user = await updateUser(req.params.id, req.body, req.adminActor);
    res.json({ ok: true, user: projectPublicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/users/:id/regenerate-token', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    const user = await regenerateUserToken(req.params.id, req.adminActor);
    res.json({ ok: true, user: projectPublicUser(user), oneTimeApiToken: user.apiToken });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', adminAuth, requireAdminCsrf, async (req, res) => {
  try {
    const removed = await deleteUser(req.params.id, req.adminActor);
    res.json({ ok: true, removed: projectPublicUser(removed) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/admin/audit-logs', adminAuth, async (_req, res) => {
  const store = await initConfigStore();
  res.json({ auditLogs: store.auditLogs });
});

// ============================================================
// PROTECTED RENDER API ENDPOINTS
// ============================================================
app.use(limiter);
app.use(auth);

// Unduh hasil render — butuh X-Token, path divalidasi agar tidak bisa traversal.
app.get('/output/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!/^[A-Za-z0-9_-]+\.(mp4|webm|mov)$/i.test(filename)) {
    return res.status(400).json({ error: 'Invalid output filename' });
  }

  const outputDir = path.resolve(process.cwd(), 'output');
  const targetPath = path.resolve(outputDir, filename);
  if (!targetPath.startsWith(outputDir + path.sep)) {
    return res.status(400).json({ error: 'Invalid output path' });
  }

  try {
    await fs.access(targetPath);
  } catch {
    return res.status(404).json({ error: 'Rendered file not found' });
  }

  res.sendFile(targetPath);
});

// Daftar template siap pakai di render-engine/templates
app.get('/templates', async (_req, res) => {
  try {
    const templatesDir = path.resolve(__dirname, '../render-engine/templates');
    const files = await fs.readdir(templatesDir);
    const templates = files
      .filter((f) => f.endsWith('.html'))
      .map((f) => ({
        id: f.replace('.html', ''),
        filename: f,
        path: `render-engine/templates/${f}`,
      }));
    res.json({ templates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Submit Job Render Motion Graphics
export function createRenderHandler(addRenderJob = enqueueRenderJob) {
  return async (req, res) => {
    try {
      const payload = { ...req.body };

      if (!payload.html && payload.template) {
        const tplFile = path.resolve(
          __dirname,
          '../render-engine/templates',
          `${path.basename(payload.template, '.html')}.html`
        );
        payload.html = await fs.readFile(tplFile, 'utf8');
      }

      validateJobLimits(payload);
      payload.html = sanitizeHtml(payload.html);
      payload.submittedBy = req.authUser?.email || req.authUser?.name || 'api_client';

      const queued = await addRenderJob(payload);
      res.status(202).json(queued);
    } catch (error) {
      // A dependency outage must not be reported as a malformed request: callers retry on
      // 5xx and give up on 4xx, and the payload was valid.
      if (error instanceof QueueUnavailableError) {
        logger.warn('Render submission rejected: queue unavailable', { error: error.message });
        return res.status(503).json({ error: 'Layanan antrean sedang tidak tersedia' });
      }
      res.status(400).json({ error: error.message });
    }
  };
}

app.post('/render', verifySignature, createRenderHandler());

// Cek Status Job Render
//
// Exported as a factory so the outage path can be driven by a rejecting lookup. The
// queue connection now fails fast, so a Redis restart makes `getJobStatus` reject.
// Express does not catch a rejected async handler, and there is no process-level
// rejection handler, so an unguarded await here would end the process instead of
// answering with a retryable status.
export function createJobStatusHandler(fetchJobStatus = getJobStatus) {
  return async (req, res) => {
    try {
      const job = await fetchJobStatus(req.params.id);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      res.json(job);
    } catch (error) {
      logger.warn('Job status unavailable', {
        jobId: req.params.id,
        error: error.message,
      });
      return res.status(503).json({ error: 'Layanan antrean sedang tidak tersedia' });
    }
  };
}

app.get('/jobs/:id', createJobStatusHandler());

// Statistik Queue
app.get('/jobs', async (_req, res) => {
  const stats = await getQueueStats();
  res.json(stats);
});

// Endpoint langsung AI Engineer Validate & Optimize (mengikuti provider aktif)
app.post('/engineer/validate', async (req, res) => {
  try {
    const result = await deepseekValidate(req.body.html || '', req.body.spec || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/engineer/optimize', async (req, res) => {
  try {
    const result = await deepseekOptimize(req.body.html || '', req.body.spec || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// BOOTSTRAP SERVER
// ============================================================
export async function startServer() {
  await initConfigStore();
  await initQueue();
  startCleanupScheduler();

  return app.listen(PORT, () => {
    logger.info(`Motion Studio VPS Render Server & Admin API listening on port ${PORT}`);
  });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await startServer();
}
