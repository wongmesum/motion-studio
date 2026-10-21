import axios from 'axios';
import { logger } from '../logger.js';
import { AI_PROVIDER_IDS, getAiConfig } from '../config-store.js';

/**
 * Server-side model registry. The browser can select a provider + model for the scene
 * prompt, but it never receives an API key: only provider/model ids cross the boundary.
 *
 * The catalog is a static list (the configured default plus env additions) merged with a
 * best-effort live discovery of `GET {baseUrl}/v1/models`. Discovery is cached in memory and
 * always fails safe — a provider outage can never remove the static entries, so the picker
 * keeps working.
 */

const DISCOVERY_TIMEOUT_MS = 5000;

const ENV_MODEL_KEYS = {
  river: 'RIVER_MODELS',
  deepseek: 'DEEPSEEK_MODELS',
};

function buildModelsUrl(baseUrl = '') {
  const clean = String(baseUrl).trim().replace(/\/+$/, '');
  if (clean.endsWith('/v1/models')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/models`;
  return `${clean}/v1/models`;
}

function parseEnvModelList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function createModelRegistry({
  getConfig = getAiConfig,
  transport = axios,
  now = () => Date.now(),
  env = process.env,
  providerIds = AI_PROVIDER_IDS,
} = {}) {
  const discoveryEnabled = env.AI_MODELS_DISCOVERY === 'true';
  const cacheTtlMs = Number(env.AI_MODELS_CACHE_TTL_MS || 600000);
  const discovered = new Map();

  async function resolveConfig(providerId) {
    return getConfig(providerId);
  }

  function staticCatalog(providerId, config) {
    const entries = [];
    const seen = new Set();
    const push = (id, source) => {
      if (id && !seen.has(id)) {
        seen.add(id);
        entries.push({ id, label: id, source });
      }
    };

    // The configured default must always survive, whatever discovery or env adds.
    push(String(config.model || '').trim(), 'default');
    for (const id of parseEnvModelList(env[ENV_MODEL_KEYS[providerId]])) {
      push(id, 'env');
    }
    return entries;
  }

  function cachedDiscovered(providerId) {
    const record = discovered.get(providerId);
    if (record && now() - record.at < cacheTtlMs) return record.ids;
    return null;
  }

  async function discover(providerId) {
    const config = await resolveConfig(providerId);
    if (!config.apiKey) {
      logger.warn('AI model discovery skipped: no API key', { providerId });
      return [];
    }

    try {
      const response = await transport.get(buildModelsUrl(config.baseUrl), {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        timeout: DISCOVERY_TIMEOUT_MS,
      });
      const ids = (Array.isArray(response?.data?.data) ? response.data.data : [])
        .map((entry) => String(entry?.id || '').trim())
        .filter(Boolean);
      discovered.set(providerId, { ids, at: now() });
      return ids;
    } catch (error) {
      logger.warn('AI model discovery failed', { providerId, error: error.message });
      return [];
    }
  }

  async function ensureDiscovered(providerId) {
    if (cachedDiscovered(providerId) !== null) return;
    if (!discoveryEnabled) return;
    await discover(providerId);
  }

  async function getModels(providerId) {
    const config = await resolveConfig(providerId);
    const entries = staticCatalog(providerId, config);
    const seen = new Set(entries.map((entry) => entry.id));

    await ensureDiscovered(providerId);
    for (const id of cachedDiscovered(providerId) || []) {
      if (id && !seen.has(id)) {
        seen.add(id);
        entries.push({ id, label: id, source: 'discovery' });
      }
    }

    return {
      providerId,
      defaultModel: String(config.model || '').trim(),
      models: entries,
    };
  }

  async function isAllowed(providerId, modelId) {
    const { models } = await getModels(providerId);
    return models.some((model) => model.id === modelId);
  }

  async function listProviders() {
    const providers = [];
    for (const providerId of providerIds) {
      const config = await resolveConfig(providerId);
      const { defaultModel, models } = await getModels(providerId);
      providers.push({
        id: providerId,
        label: config.provider || providerId,
        configured: Boolean(config.apiKey),
        defaultModel,
        models,
      });
    }
    return { providers };
  }

  return { getModels, discover, isAllowed, listProviders };
}
