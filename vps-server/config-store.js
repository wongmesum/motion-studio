import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR override lets tests exercise secret generation in an isolated folder
const DATA_DIR = process.env.MOTION_DATA_DIR
  ? path.resolve(process.env.MOTION_DATA_DIR)
  : path.resolve(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'admin-store.json');
const GENERATED_SECRETS_FILE = path.join(DATA_DIR, 'generated-secrets.json');
const PLACEHOLDER_SECRETS = new Set([
  '',
  'change_me_strong_secret_token_2026',
  'ms_admin_master_2026',
  'your_vps_token_here',
  'your_admin_token_here',
  'your_hmac_secret_here',
]);

function isPlaceholderSecret(value) {
  return !value || PLACEHOLDER_SECRETS.has(String(value).trim());
}

function createSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('hex')}`;
}

// Secrets live only in the restricted generated-secrets file, never in admin-store.json.
const SERVICE_SECRET_FIELDS = ['vpsToken', 'adminToken', 'hmacSecret', 'webhookSecret'];

function pickServiceSecrets(source = {}) {
  return Object.fromEntries(
    SERVICE_SECRET_FIELDS.map((field) => [field, source[field] || ''])
  );
}

function buildPersistedSecrets(store) {
  const aiProviderKeys = Object.fromEntries(
    AI_PROVIDER_IDS.map((providerId) => [
      providerId,
      store.aiProviders?.[providerId]?.apiKey || '',
    ])
  );
  const vaultKeys = Object.fromEntries(
    (store.keyVault || [])
      .filter((key) => key.id && key.apiKey)
      .map((key) => [key.id, key.apiKey])
  );
  return {
    ...pickServiceSecrets(store.serviceKeys),
    aiProviderKeys,
    vaultKeys,
  };
}

async function persistRuntimeSecrets(secrets) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(GENERATED_SECRETS_FILE, JSON.stringify(secrets, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  // writeFile only applies mode at creation, so an existing file keeps its old bits.
  try {
    await fs.chmod(GENERATED_SECRETS_FILE, 0o600);
  } catch (error) {
    throw new Error(`Failed to restrict generated-secrets permissions: ${error.message}`);
  }
}

async function loadStoredRuntimeSecrets() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(GENERATED_SECRETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function resolveRuntimeSecrets(stored = {}, legacy = {}) {
  const resolveRequiredSecret = (environmentValue, storedValue, legacyValue, prefix) => {
    if (!isPlaceholderSecret(environmentValue)) return environmentValue;
    if (!isPlaceholderSecret(storedValue)) return storedValue;
    if (!isPlaceholderSecret(legacyValue)) return legacyValue;
    return createSecret(prefix);
  };

  return {
    vpsToken: resolveRequiredSecret(
      process.env.VPS_TOKEN,
      stored.vpsToken,
      legacy.vpsToken,
      'ms_vps'
    ),
    adminToken: resolveRequiredSecret(
      process.env.ADMIN_TOKEN,
      stored.adminToken,
      legacy.adminToken,
      'ms_admin'
    ),
    hmacSecret: resolveRequiredSecret(
      process.env.HMAC_SECRET,
      stored.hmacSecret,
      legacy.hmacSecret,
      'ms_hmac'
    ),
    webhookSecret:
      process.env.WEBHOOK_SECRET || stored.webhookSecret || legacy.webhookSecret || '',
  };
}

export function generateConversationId() {
  return crypto.randomUUID().toLowerCase();
}

export function generateUserToken(prefix = 'ms_live') {
  return `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
}

function hashUserToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function migrateUserToken(user = {}) {
  if (!user.apiToken) return user;
  const { apiToken, ...metadata } = user;
  return {
    ...metadata,
    apiTokenHash: hashUserToken(apiToken),
    maskedApiToken: maskSecret(apiToken),
  };
}

export function maskSecret(secret = '') {
  if (!secret || secret.length < 8) return secret ? '••••••••' : '';
  return `${secret.slice(0, 6)}••••••••••••••••${secret.slice(-4)}`;
}

export function projectPublicUser(user = {}) {
  const { apiToken: _apiToken, apiTokenHash: _apiTokenHash, ...publicUser } = user;
  return {
    ...publicUser,
    maskedApiToken: user.maskedApiToken || maskSecret(user.apiToken),
  };
}

export function projectPublicKey(key = {}) {
  const { apiKey: _apiKey, ...publicKey } = key;
  return {
    ...publicKey,
    maskedKey: maskSecret(key.apiKey),
  };
}

export function projectPublicServiceKeys(serviceKeys = {}) {
  return {
    higgsfieldApiUrl: serviceKeys.higgsfieldApiUrl || '',
    higgsfieldModel: serviceKeys.higgsfieldModel || '',
    requireHmacSignature: Boolean(serviceKeys.requireHmacSignature),
    webhookUrl: serviceKeys.webhookUrl || '',
    maskedHiggsfieldKey: maskSecret(serviceKeys.higgsfieldApiKey),
    maskedVpsToken: maskSecret(serviceKeys.vpsToken),
    maskedAdminToken: maskSecret(serviceKeys.adminToken),
    hmacConfigured: Boolean(serviceKeys.hmacSecret),
  };
}

export function projectPublicRiverConfig(riverConfig = {}) {
  const { apiKey: _apiKey, ...publicConfig } = riverConfig;
  return {
    ...publicConfig,
    maskedApiKey: maskSecret(riverConfig.apiKey),
  };
}

export const AI_PROVIDER_IDS = ['river', 'deepseek'];

function isSupportedAiProvider(providerId) {
  return AI_PROVIDER_IDS.includes(providerId);
}

const DEFAULT_AI_PROVIDERS = {
  river: {
    providerId: 'river',
    provider: 'River AI',
    docsUrl: 'https://console.river.ai/keys',
    baseUrl: process.env.RIVER_API_BASE_URL || 'https://api.river.ai',
    apiKey: process.env.RIVER_API_KEY || '',
    model: process.env.RIVER_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash',
    stream: true,
    temperature: 0.7,
    maxTokens: 2048,
    chatTemplateKwargs: { enable_thinking: false },
    maxFixAttempts: Number(process.env.DEEPSEEK_MAX_FIX_ATTEMPTS || 3),
    updatedAt: new Date().toISOString(),
  },
  deepseek: {
    providerId: 'deepseek',
    provider: 'DeepSeek Official',
    docsUrl: 'https://api-docs.deepseek.com/',
    baseUrl: process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    stream: true,
    temperature: 0.7,
    maxTokens: 2048,
    maxFixAttempts: Number(process.env.DEEPSEEK_MAX_FIX_ATTEMPTS || 3),
    updatedAt: new Date().toISOString(),
  },
};

export function projectPublicAiConfig({ activeAiProvider = 'river', aiProviders = {} } = {}) {
  const providers = Object.fromEntries(
    AI_PROVIDER_IDS.map((providerId) => [
      providerId,
      projectPublicRiverConfig(aiProviders[providerId] || {}),
    ])
  );
  return { activeAiProvider, providers };
}

const configuredProvider = isSupportedAiProvider(process.env.AI_PROVIDER)
  ? process.env.AI_PROVIDER
  : 'river';

const DEFAULT_STORE = {
  activeAiProvider: configuredProvider,
  aiProviders: structuredClone(DEFAULT_AI_PROVIDERS),
  // Compatibility projection for older dashboard/API clients during migration.
  riverConfig: structuredClone(DEFAULT_AI_PROVIDERS.river),
  serviceKeys: {
    higgsfieldApiUrl: process.env.HIGGSFIELD_API_URL || 'https://api.higgsfield.ai',
    higgsfieldApiKey: process.env.HIGGSFIELD_API_KEY || '',
    higgsfieldModel: process.env.HIGGSFIELD_DEFAULT_MODEL || 'soul',
    vpsToken: '',
    adminToken: '',
    hmacSecret: '',
    requireHmacSignature: process.env.REQUIRE_HMAC_SIGNATURE === 'true',
    webhookUrl: process.env.WEBHOOK_URL || '',
    webhookSecret: process.env.WEBHOOK_SECRET || '',
  },
  keyVault: AI_PROVIDER_IDS.flatMap((providerId) => {
    const config = DEFAULT_AI_PROVIDERS[providerId];
    if (!config.apiKey) return [];
    return [{
      id: `key_${providerId}_primary`,
      label: `${config.provider} Production`,
      providerId,
      provider: config.provider,
      env: 'production',
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      isActive: true,
      requestsCount: 0,
      tokensUsed: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    }];
  }),
  users: [],
  auditLogs: [],
};

let memoryStore = null;

/**
 * Stores written before multi-provider support only had a flat `riverConfig`.
 * Fold that legacy value into the River provider entry so existing deployments
 * keep their endpoint, key, and model after upgrade.
 */
function migrateAiProviders(store = {}) {
  const legacyRiver = store.riverConfig || {};
  const configured = store.aiProviders || {};
  const merged = {};

  for (const providerId of AI_PROVIDER_IDS) {
    const defaults = DEFAULT_AI_PROVIDERS[providerId];
    const source = configured[providerId] || (providerId === 'river' ? legacyRiver : {});
    merged[providerId] = {
      ...defaults,
      ...source,
      providerId,
      ...(providerId === 'river'
        ? {
            chatTemplateKwargs: {
              enable_thinking: false,
              ...(source.chatTemplateKwargs || {}),
            },
          }
        : {}),
    };
  }

  return merged;
}

export async function initConfigStore() {
  if (memoryStore) return memoryStore;
  await fs.mkdir(DATA_DIR, { recursive: true });
  const storedSecrets = await loadStoredRuntimeSecrets();
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    memoryStore = JSON.parse(raw);
    memoryStore.aiProviders = migrateAiProviders(memoryStore);
    memoryStore.activeAiProvider = isSupportedAiProvider(memoryStore.activeAiProvider)
      ? memoryStore.activeAiProvider
      : configuredProvider;
    memoryStore.riverConfig = { ...memoryStore.aiProviders.river };
    memoryStore.serviceKeys = {
      ...DEFAULT_STORE.serviceKeys,
      ...(memoryStore.serviceKeys || {}),
    };
    memoryStore.keyVault = Array.isArray(memoryStore.keyVault) ? memoryStore.keyVault : [];
    memoryStore.keyVault = memoryStore.keyVault.map((key) => ({
      ...key,
      apiKey: key.apiKey || storedSecrets.vaultKeys?.[key.id] || '',
      providerId: isSupportedAiProvider(key.providerId) ? key.providerId : 'river',
    }));
    memoryStore.users = Array.isArray(memoryStore.users)
      ? memoryStore.users.map(migrateUserToken)
      : [];
    memoryStore.auditLogs = Array.isArray(memoryStore.auditLogs) ? memoryStore.auditLogs : [];
  } catch {
    memoryStore = structuredClone(DEFAULT_STORE);
  }

  const runtimeSecrets = resolveRuntimeSecrets(storedSecrets, memoryStore.serviceKeys);
  for (const field of SERVICE_SECRET_FIELDS) {
    memoryStore.serviceKeys[field] = runtimeSecrets[field] || '';
  }

  for (const providerId of AI_PROVIDER_IDS) {
    const provider = memoryStore.aiProviders[providerId];
    const storedProviderKey = storedSecrets.aiProviderKeys?.[providerId] || '';
    if (!provider.apiKey && storedProviderKey) provider.apiKey = storedProviderKey;
    if (!provider.apiKey) {
      const vaultKey = memoryStore.keyVault.find((key) => key.providerId === providerId && key.apiKey);
      if (vaultKey) provider.apiKey = vaultKey.apiKey;
    }
  }
  memoryStore.riverConfig = { ...memoryStore.aiProviders.river };

  await saveConfigStore();
  return memoryStore;
}

/**
 * Strip every secret before writing admin-store.json. AI provider keys and vault keys
 * join the service secrets in generated-secrets.json so the main store stays safe to
 * copy, diff, or back up.
 */
export async function saveConfigStore() {
  if (!memoryStore) return;
  await fs.mkdir(DATA_DIR, { recursive: true });

  const serviceKeys = { ...memoryStore.serviceKeys };
  for (const field of SERVICE_SECRET_FIELDS) delete serviceKeys[field];

  const aiProviders = { ...memoryStore.aiProviders };
  for (const providerId of AI_PROVIDER_IDS) {
    const { apiKey: _apiKey, ...rest } = aiProviders[providerId] || {};
    aiProviders[providerId] = rest;
  }

  const keyVault = memoryStore.keyVault.map(({ apiKey: _apiKey, ...rest }) => rest);
  const { apiKey: _riverApiKey, ...riverConfig } = memoryStore.riverConfig || {};

  // User tokens are stored as SHA-256 digests only; the plaintext never reaches disk.
  const users = memoryStore.users.map(({ apiToken: _apiToken, ...rest }) =>
    migrateUserToken({ ...rest, apiToken: _apiToken })
  );

  await persistRuntimeSecrets(buildPersistedSecrets(memoryStore));
  await fs.writeFile(
    STORE_FILE,
    JSON.stringify(
      { ...memoryStore, serviceKeys, aiProviders, keyVault, riverConfig, users },
      null,
      2
    ),
    'utf8'
  );
}

export async function addAuditLog(actor, action, detail) {
  const store = await initConfigStore();
  const entry = {
    id: `log_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    timestamp: new Date().toISOString(),
    actor,
    action,
    detail,
  };
  store.auditLogs.unshift(entry);
  if (store.auditLogs.length > 200) {
    store.auditLogs = store.auditLogs.slice(0, 200);
  }
  await saveConfigStore();
  logger.info(`Admin Audit: ${action}`, { actor, detail });
  return entry;
}

export async function getAiConfig(providerId) {
  const store = await initConfigStore();
  const selectedProvider = providerId || store.activeAiProvider;
  if (!isSupportedAiProvider(selectedProvider)) {
    throw new Error(`Unsupported AI provider: ${selectedProvider}`);
  }
  return {
    ...store.aiProviders[selectedProvider],
    providerId: selectedProvider,
  };
}

export async function getRiverConfig() {
  return getAiConfig('river');
}

export async function getServiceKeys() {
  const store = await initConfigStore();
  return store.serviceKeys;
}

function applyProviderConfig(current, patch, providerId) {
  const updated = { ...current };
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
    const baseUrl = new URL(patch.baseUrl.trim());
    if (baseUrl.protocol !== 'https:') throw new Error('AI provider base URL must use HTTPS');
    updated.baseUrl = baseUrl.toString().replace(/\/+$/, '');
  }
  if (typeof patch.apiKey === 'string' && !patch.apiKey.includes('••••')) {
    updated.apiKey = patch.apiKey.trim();
  }
  if (typeof patch.model === 'string' && patch.model.trim()) updated.model = patch.model.trim();
  if (typeof patch.stream === 'boolean') updated.stream = patch.stream;
  if (patch.temperature !== undefined) {
    const temperature = Number(patch.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new Error('AI provider temperature must be between 0 and 2');
    }
    updated.temperature = temperature;
  }
  if (patch.maxTokens !== undefined) {
    const maxTokens = Number(patch.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) {
      throw new Error('AI provider maxTokens must be an integer between 1 and 32768');
    }
    updated.maxTokens = maxTokens;
  }
  if (providerId === 'river' && patch.chatTemplateKwargs) {
    updated.chatTemplateKwargs = {
      ...updated.chatTemplateKwargs,
      ...patch.chatTemplateKwargs,
    };
  }
  if (patch.maxFixAttempts !== undefined) updated.maxFixAttempts = Number(patch.maxFixAttempts);
  return { ...updated, updatedAt: new Date().toISOString() };
}

export async function updateApiKeysConfig(payload = {}, actor = 'Admin Dashboard') {
  const store = await initConfigStore();

  if (payload.activeAiProvider !== undefined) {
    if (!isSupportedAiProvider(payload.activeAiProvider)) {
      throw new Error(`Unsupported AI provider: ${payload.activeAiProvider}`);
    }
    store.activeAiProvider = payload.activeAiProvider;
  }

  const providerPatches = {
    ...(payload.aiProviders || {}),
    ...(payload.riverConfig ? { river: payload.riverConfig } : {}),
  };
  for (const [providerId, patch] of Object.entries(providerPatches)) {
    if (!isSupportedAiProvider(providerId)) {
      throw new Error(`Unsupported AI provider: ${providerId}`);
    }
    store.aiProviders[providerId] = applyProviderConfig(
      store.aiProviders[providerId],
      patch || {},
      providerId
    );
    const activeKey = store.keyVault.find(
      (key) => key.providerId === providerId && key.isActive
    );
    if (activeKey && store.aiProviders[providerId].apiKey) {
      activeKey.apiKey = store.aiProviders[providerId].apiKey;
      activeKey.baseUrl = store.aiProviders[providerId].baseUrl;
      activeKey.model = store.aiProviders[providerId].model;
    }
  }
  store.riverConfig = { ...store.aiProviders.river };

  if (payload.serviceKeys) {
    const sk = payload.serviceKeys;
    if (typeof sk.higgsfieldApiUrl === 'string') store.serviceKeys.higgsfieldApiUrl = sk.higgsfieldApiUrl.trim();
    if (typeof sk.higgsfieldApiKey === 'string' && !sk.higgsfieldApiKey.includes('••••')) {
      store.serviceKeys.higgsfieldApiKey = sk.higgsfieldApiKey.trim();
    }
    if (typeof sk.higgsfieldModel === 'string') store.serviceKeys.higgsfieldModel = sk.higgsfieldModel.trim();
    if (typeof sk.vpsToken === 'string' && !sk.vpsToken.includes('••••') && sk.vpsToken.trim()) {
      store.serviceKeys.vpsToken = sk.vpsToken.trim();
    }
    if (typeof sk.adminToken === 'string' && !sk.adminToken.includes('••••') && sk.adminToken.trim()) {
      store.serviceKeys.adminToken = sk.adminToken.trim();
    }
    if (typeof sk.hmacSecret === 'string' && !sk.hmacSecret.includes('••••') && sk.hmacSecret.trim()) {
      store.serviceKeys.hmacSecret = sk.hmacSecret.trim();
    }
    if (typeof sk.requireHmacSignature === 'boolean') {
      store.serviceKeys.requireHmacSignature = sk.requireHmacSignature;
    }
    if (typeof sk.webhookUrl === 'string') store.serviceKeys.webhookUrl = sk.webhookUrl.trim();
    if (typeof sk.webhookSecret === 'string' && !sk.webhookSecret.includes('••••')) {
      store.serviceKeys.webhookSecret = sk.webhookSecret.trim();
    }
  }

  await saveConfigStore();
  const activeConfig = store.aiProviders[store.activeAiProvider];
  await addAuditLog(
    actor,
    'API_KEYS_UPDATED',
    `Updated ${activeConfig.provider} (${activeConfig.model} @ ${activeConfig.baseUrl}) & Service Keys`
  );
  return store;
}

export async function addKeyToVault(keyData, actor = 'Admin Dashboard') {
  const store = await initConfigStore();
  const providerId = keyData.providerId || store.activeAiProvider;
  if (!isSupportedAiProvider(providerId)) {
    throw new Error(`Unsupported AI provider: ${providerId}`);
  }
  const apiKey = (keyData.apiKey || '').trim();
  if (!apiKey) throw new Error('API key is required');

  const providerConfig = store.aiProviders[providerId];
  const newKey = {
    id: `key_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    label: keyData.label || `${providerConfig.provider} API Key`,
    providerId,
    provider: providerConfig.provider,
    env: keyData.env || 'production',
    baseUrl: (keyData.baseUrl || providerConfig.baseUrl).replace(/\/+$/, ''),
    apiKey,
    model: keyData.model || providerConfig.model,
    isActive: Boolean(keyData.setActive),
    requestsCount: 0,
    tokensUsed: 0,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  if (newKey.isActive) {
    // Activation is scoped to one provider; the active provider itself is unchanged.
    store.keyVault
      .filter((key) => key.providerId === providerId)
      .forEach((key) => {
        key.isActive = false;
      });
    store.aiProviders[providerId] = applyProviderConfig(
      providerConfig,
      { apiKey: newKey.apiKey, baseUrl: newKey.baseUrl, model: newKey.model },
      providerId
    );
  }

  store.keyVault.unshift(newKey);
  store.riverConfig = { ...store.aiProviders.river };
  await saveConfigStore();
  await addAuditLog(
    actor,
    'VAULT_KEY_ADDED',
    `Added ${newKey.provider} key "${newKey.label}" (${maskSecret(newKey.apiKey)})`
  );
  return newKey;
}

export async function activateVaultKey(keyId, actor = 'Admin Dashboard') {
  const store = await initConfigStore();
  const target = store.keyVault.find((key) => key.id === keyId);
  if (!target) throw new Error('API Key not found in vault');

  const providerId = target.providerId || 'river';
  store.keyVault
    .filter((key) => key.providerId === providerId)
    .forEach((key) => {
      key.isActive = key.id === keyId;
    });
  store.aiProviders[providerId] = applyProviderConfig(
    store.aiProviders[providerId],
    {
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      model: target.model,
    },
    providerId
  );
  store.riverConfig = { ...store.aiProviders.river };

  await saveConfigStore();
  await addAuditLog(actor, 'VAULT_KEY_ACTIVATED', `Switched active ${target.provider} key to "${target.label}"`);
  return target;
}

export async function deleteVaultKey(keyId, actor = 'Admin Dashboard') {
  const store = await initConfigStore();
  const idx = store.keyVault.findIndex((key) => key.id === keyId);
  if (idx === -1) throw new Error('API Key not found in vault');
  const removed = store.keyVault.splice(idx, 1)[0];

  if (removed.isActive) {
    const replacement = store.keyVault.find((key) => key.providerId === removed.providerId);
    if (replacement) {
      replacement.isActive = true;
      store.aiProviders[removed.providerId] = applyProviderConfig(
        store.aiProviders[removed.providerId],
        { apiKey: replacement.apiKey, baseUrl: replacement.baseUrl, model: replacement.model },
        removed.providerId
      );
    }
  }
  store.riverConfig = { ...store.aiProviders.river };
  await saveConfigStore();
  await addAuditLog(actor, 'VAULT_KEY_DELETED', `Deleted ${removed.provider} key "${removed.label}"`);
  return removed;
}

export async function recordRiverUsage(tokensEstimate = 512, providerId) {
  const store = await initConfigStore();
  const selectedProvider = providerId || store.activeAiProvider;
  const active = store.keyVault.find(
    (key) => key.isActive && key.providerId === selectedProvider
  );
  if (active) {
    active.requestsCount = (active.requestsCount || 0) + 1;
    active.tokensUsed = (active.tokensUsed || 0) + tokensEstimate;
    active.lastUsedAt = new Date().toISOString();
    await saveConfigStore();
  }
}

// ============================================================
// USER MANAGEMENT FUNCTIONS
// ============================================================
export async function listUsers() {
  const store = await initConfigStore();
  return store.users;
}

export async function findUserByToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const store = await initConfigStore();
  const provided = Buffer.from(hashUserToken(token), 'hex');
  return store.users.find((user) => {
    if (!/^[a-f0-9]{64}$/i.test(user.apiTokenHash || '')) return false;
    const expected = Buffer.from(user.apiTokenHash, 'hex');
    return crypto.timingSafeEqual(provided, expected);
  }) || null;
}

export async function createUser(userData, actor = 'Admin Dashboard') {
  const store = await initConfigStore();
  if (!userData.name || !userData.email) {
    throw new Error('Name and email are required');
  }
  const rolePrefix = userData.role === 'admin' ? 'ms_live_adm' : userData.role === 'engineer' ? 'ms_live_eng' : 'ms_live_usr';
  const apiToken = userData.apiToken || generateUserToken(rolePrefix);
  const newUser = {
    id: `usr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    name: userData.name.trim(),
    email: userData.email.trim().toLowerCase(),
    role: userData.role || 'creator',
    status: userData.status || 'active',
    apiTokenHash: hashUserToken(apiToken),
    maskedApiToken: maskSecret(apiToken),
    quotaLimit: Number(userData.quotaLimit ?? 500),
    quotaUsed: Number(userData.quotaUsed ?? 0),
    rateLimitPerMin: Number(userData.rateLimitPerMin ?? 30),
    riverAccess: userData.riverAccess !== undefined ? Boolean(userData.riverAccess) : true,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };

  store.users.unshift(newUser);
  await saveConfigStore();
  await addAuditLog(actor, 'USER_CREATED', `Created user ${newUser.name} (${newUser.email}) with role=${newUser.role}`);
  return { ...newUser, apiToken };
}

export async function updateUser(userId, patch, actor = 'Admin Dashboard') {
  const store = await initConfigStore();
  const user = store.users.find((u) => u.id === userId);
  if (!user) throw new Error('User not found');

  if (typeof patch.name === 'string' && patch.name.trim()) user.name = patch.name.trim();
  if (typeof patch.email === 'string' && patch.email.trim()) user.email = patch.email.trim().toLowerCase();
  if (typeof patch.role === 'string') user.role = patch.role;
  if (typeof patch.status === 'string') user.status = patch.status;
  if (patch.quotaLimit !== undefined) user.quotaLimit = Number(patch.quotaLimit);
  if (patch.quotaUsed !== undefined) user.quotaUsed = Number(patch.quotaUsed);
  if (patch.rateLimitPerMin !== undefined) user.rateLimitPerMin = Number(patch.rateLimitPerMin);
  if (patch.riverAccess !== undefined) user.riverAccess = Boolean(patch.riverAccess);

  await saveConfigStore();
  await addAuditLog(actor, 'USER_UPDATED', `Updated user ${user.name} (${user.email}) — status=${user.status}, role=${user.role}`);
  return user;
}

export async function regenerateUserToken(userId, actor = 'Admin Dashboard') {
  const store = await initConfigStore();
  const user = store.users.find((u) => u.id === userId);
  if (!user) throw new Error('User not found');

  const rolePrefix = user.role === 'admin' ? 'ms_live_adm' : user.role === 'engineer' ? 'ms_live_eng' : 'ms_live_usr';
  const apiToken = generateUserToken(rolePrefix);
  user.apiTokenHash = hashUserToken(apiToken);
  user.maskedApiToken = maskSecret(apiToken);
  user.lastActiveAt = new Date().toISOString();

  await saveConfigStore();
  await addAuditLog(actor, 'USER_TOKEN_ROTATED', `Rotated API Token for ${user.name} (${user.email})`);
  return { ...user, apiToken };
}

export async function deleteUser(userId, actor = 'Admin Dashboard') {
  const store = await initConfigStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) throw new Error('User not found');
  const removed = store.users.splice(idx, 1)[0];

  await saveConfigStore();
  await addAuditLog(actor, 'USER_DELETED', `Deleted user ${removed.name} (${removed.email})`);
  return removed;
}

export async function incrementUserQuota(userId) {
  const store = await initConfigStore();
  const user = store.users.find((u) => u.id === userId);
  if (user) {
    user.quotaUsed = (user.quotaUsed || 0) + 1;
    user.lastActiveAt = new Date().toISOString();
    await saveConfigStore();
  }
}
