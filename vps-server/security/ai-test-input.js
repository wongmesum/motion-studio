const SUPPORTED_PROVIDER_IDS = ['river', 'deepseek'];
const MAX_PROMPT_LENGTH = 10000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_FIELDS = new Set([
  'providerId',
  'prompt',
  'conversationId',
  'temperature',
  'maxTokens',
  'stream',
  'enableThinking',
]);

// JSON bodies carry real numbers, so coerce nothing: a stringified "0.5" is a client bug.
export function parseTemperature(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error('AI provider temperature must be between 0 and 2');
  }
  return value;
}

export function parseMaxTokens(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 32768) {
    throw new Error('AI provider maxTokens must be an integer between 1 and 32768');
  }
  return value;
}

function parseBooleanField(value, field) {
  if (typeof value !== 'boolean') {
    throw new Error(`Field ${field} harus berupa boolean`);
  }
  return value;
}

function parsePrompt(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Prompt wajib diisi');
  }
  if (value.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt maksimum ${MAX_PROMPT_LENGTH} karakter`);
  }
  return value;
}

function parseConversationId(value) {
  const conversationId = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(conversationId)) {
    throw new Error('conversationId harus berupa UUID yang valid');
  }
  return conversationId;
}

function rejectUnknownFields(body) {
  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new Error(`Field tidak didukung: ${field}`);
    }
  }
}

/**
 * Narrow the admin playground payload before it reaches a paid provider.
 * Credential overrides are not part of the contract and are rejected outright.
 */
export function validateAiTestInput(body = {}, forcedProviderId = null) {
  rejectUnknownFields(body);

  let providerId = forcedProviderId;
  if (body.providerId !== undefined) {
    if (!SUPPORTED_PROVIDER_IDS.includes(body.providerId)) {
      throw new Error(`Provider AI tidak didukung: ${body.providerId}`);
    }
    if (forcedProviderId && body.providerId !== forcedProviderId) {
      throw new Error(`Endpoint ini harus menggunakan provider ${forcedProviderId}`);
    }
    providerId = body.providerId;
  }

  const validated = { prompt: parsePrompt(body.prompt) };
  if (providerId) validated.providerId = providerId;
  if (body.conversationId !== undefined) {
    validated.conversationId = parseConversationId(body.conversationId);
  }
  if (body.temperature !== undefined) {
    validated.temperature = parseTemperature(body.temperature);
  }
  if (body.maxTokens !== undefined) {
    validated.maxTokens = parseMaxTokens(body.maxTokens);
  }
  if (body.stream !== undefined) {
    validated.stream = parseBooleanField(body.stream, 'stream');
  }
  if (body.enableThinking !== undefined) {
    validated.enableThinking = parseBooleanField(body.enableThinking, 'enableThinking');
  }

  return validated;
}
