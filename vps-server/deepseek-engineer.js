import axios from 'axios';
import crypto from 'crypto';
import { chromium } from 'playwright';
import { logger, metrics } from './logger.js';
import { applyRenderNetworkPolicy } from './security/network-policy.js';
import {
  getAiConfig,
  generateConversationId,
  recordRiverUsage,
} from './config-store.js';

/**
 * Normalisasi URL endpoint River AI agar selalu mengarah ke:
 * $RIVER_API_BASE_URL/v1/chat/completions
 */
export function buildAiCompletionsUrl(baseUrl = 'https://api.river.ai') {
  const clean = String(baseUrl || 'https://api.river.ai').trim().replace(/\/+$/, '');
  if (clean.endsWith('/v1/chat/completions')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

export const buildRiverCompletionsUrl = buildAiCompletionsUrl;

/**
 * Provider-specific request shape. Both providers are OpenAI-compatible, but only
 * River accepts the conversation header and chat_template_kwargs extension.
 */
export function buildAiChatRequest(providerId, config = {}, options = {}) {
  const {
    messages = [{ role: 'user', content: 'Tell me a story.' }],
    temperature,
    maxTokens,
    enableThinking,
    stream,
    conversationId,
  } = options;

  const resolvedStream = stream !== undefined ? Boolean(stream) : Boolean(config.stream ?? true);
  const body = {
    model: config.model,
    stream: resolvedStream,
    temperature: temperature !== undefined ? Number(temperature) : Number(config.temperature ?? 0.7),
    max_tokens: maxTokens !== undefined ? Number(maxTokens) : Number(config.maxTokens ?? 2048),
    messages,
  };
  const headers = {
    Authorization: `Bearer ${config.apiKey || ''}`,
    'Content-Type': 'application/json',
  };
  const convId = (conversationId || generateConversationId()).toLowerCase();

  if (providerId === 'river') {
    const resolvedThinking =
      enableThinking !== undefined
        ? Boolean(enableThinking)
        : Boolean(config.chatTemplateKwargs?.enable_thinking ?? false);
    body.chat_template_kwargs = { enable_thinking: resolvedThinking };
    headers['X-River-Conversation-Id'] = convId;
  }

  return {
    endpoint: buildAiCompletionsUrl(config.baseUrl),
    headers,
    body,
    stream: resolvedStream,
    conversationId: convId,
  };
}

/**
 * Render a copy-pasteable cURL example for the selected provider. River keeps its
 * gateway header and thinking flag; official DeepSeek is plain OpenAI-compatible.
 */
export function buildAiCurlCommand(providerId, {
  baseUrl = providerId === 'river' ? '$RIVER_API_BASE_URL' : '$DEEPSEEK_API_BASE_URL',
  model,
  stream = true,
  temperature = 0.7,
  maxTokens = 2048,
  enableThinking = false,
  prompt = 'Tell me a story.',
} = {}) {
  const cleanBase = String(baseUrl).replace(/\/v1(\/chat\/completions)?$/, '');
  const body = {
    model,
    stream,
    temperature,
    max_tokens: maxTokens,
  };
  const headerLines = [`  -H "Authorization: Bearer $${providerId === 'river' ? 'RIVER' : 'DEEPSEEK'}_API_KEY" \\`];
  headerLines.push('  -H "Content-Type: application/json" \\');

  if (providerId === 'river') {
    headerLines.push('  -H "X-River-Conversation-Id: $CONVERSATION_ID" \\');
    body.chat_template_kwargs = { enable_thinking: Boolean(enableThinking) };
  }
  body.messages = [{ role: 'user', content: prompt }];

  return `CONVERSATION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
curl -N "${cleanBase}/v1/chat/completions" \\
${headerLines.join('\n')}
  -d '${JSON.stringify(body, null, 2)}'`;
}

/** @deprecated River-only alias kept for existing callers and tests. */
export function buildRiverCurlCommand(options = {}) {
  return buildAiCurlCommand('river', options);
}

/**
 * Check whether the selected provider has a usable API key configured.
 */
export async function hasRiverApiKey(overrideKey, providerId) {
  const cfg = await getAiConfig(providerId);
  const key = overrideKey || cfg.apiKey || '';
  return Boolean(
    key &&
      key !== 'your_deepseek_api_key_here' &&
      key !== 'your_river_api_key_here'
  );
}

/**
 * Parser respons SSE (Server-Sent Events) dari River AI ketika stream: true
 */
function parseSseStreamPayload(rawText) {
  if (typeof rawText !== 'string') {
    if (rawText?.choices?.[0]?.message?.content) {
      return rawText.choices[0].message.content;
    }
    return JSON.stringify(rawText);
  }

  const trimmed = rawText.trim();
  // Jika bukan format data: SSE (misal server mengembalikan JSON langsung)
  if (trimmed.startsWith('{') && !trimmed.startsWith('data:')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.choices?.[0]?.message?.content) {
        return parsed.choices[0].message.content;
      }
    } catch {
      // Lanjut ke parser baris
    }
  }

  let fullContent = '';
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const cleanLine = line.trim();
    if (!cleanLine.startsWith('data:')) continue;
    const dataStr = cleanLine.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') continue;
    try {
      const chunk = JSON.parse(dataStr);
      const delta =
        chunk?.choices?.[0]?.delta?.content ??
        chunk?.choices?.[0]?.message?.content ??
        '';
      if (delta) fullContent += delta;
    } catch {
      // Abaikan baris komentar / keep-alive
    }
  }
  return fullContent || trimmed;
}

/**
 * Ekstrak objek JSON dari teks respons model (mendukung blok ```json ... ```)
 */
function extractJsonObject(text) {
  if (!text) throw new Error('Empty response from AI provider');
  if (typeof text === 'object') return text;
  const cleaned = String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse JSON from model response: ${cleaned.slice(0, 160)}`);
  }
}

// ============================================================
// CORE: provider-neutral chat call with provider-specific adapters
// ============================================================
export async function callAiChat({
  providerId,
  messages,
  temperature,
  maxTokens,
  enableThinking,
  stream,
  conversationId,
  apiKey,
  baseUrl,
  model,
} = {}) {
  const cfg = await getAiConfig(providerId);
  const resolvedProvider = providerId || cfg.providerId;
  const resolvedConfig = {
    ...cfg,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
  };
  const request = buildAiChatRequest(resolvedProvider, resolvedConfig, {
    messages,
    temperature,
    maxTokens,
    enableThinking,
    stream,
    conversationId,
  });

  const startedAt = Date.now();
  const res = await axios.post(request.endpoint, request.body, {
    headers: request.headers,
    responseType: request.stream ? 'text' : 'json',
    timeout: 60000,
  });
  const content = request.stream
    ? parseSseStreamPayload(res.data)
    : res.data?.choices?.[0]?.message?.content || '';

  await recordRiverUsage(Math.max(128, Math.round(content.length / 3)), resolvedProvider);
  return {
    content,
    providerId: resolvedProvider,
    conversationId: request.conversationId,
    model: resolvedConfig.model,
    endpoint: request.endpoint,
    stream: request.stream,
    latencyMs: Date.now() - startedAt,
    requestBody: request.body,
  };
}

export async function callRiverChat(options = {}) {
  return callAiChat({ ...options, providerId: options.providerId || 'river' });
}

async function callDeepSeek(systemPrompt, userPrompt, temperature = 0.2) {
  const response = await callAiChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    maxTokens: 2048,
    enableThinking: false,
    stream: true,
  });
  return extractJsonObject(response.content);
}

// ============================================================
// TAHAP 1: VALIDATE (Cek sintaks & determinisme)
// ============================================================
export async function validate(html, spec = {}) {
  const localIssues = [];
  if (!/<!DOCTYPE html>/i.test(html) && !/<html/i.test(html)) {
    localIssues.push('Missing <!DOCTYPE html> or <html> root element');
  }
  if (!/renderFrame\s*=|function\s+renderFrame/.test(html)) {
    localIssues.push('Missing window.renderFrame(t) deterministic entry point');
  }
  if (/\bsetInterval\s*\(/.test(html)) {
    localIssues.push('Uses setInterval() which is non-deterministic for frame-by-frame capture');
  }

  if (!(await hasRiverApiKey())) {
    return {
      valid: localIssues.length === 0,
      issues: localIssues,
      severity: localIssues.length === 0 ? 'ok' : 'warn',
      engine: 'local_static_validator',
    };
  }

  try {
    const cfg = await getAiConfig();
    const result = await callDeepSeek(
      `You are a strict HTML validator for motion graphics rendering.
Return JSON: { "valid": boolean, "issues": string[], "severity": "ok"|"warn"|"error" }`,
      `Validate this HTML for Playwright frame-by-frame rendering.
Spec: ${JSON.stringify(spec)}
HTML:
\`\`\`html
${html}
\`\`\`

Check:
1. Has <!DOCTYPE html> and <html> tag
2. Has window.renderFrame(t) function
3. No setTimeout/setInterval for animation (must be frame-based)
4. No fetch() that could hang
5. Viewport dimensions match spec`
    );
    return { ...result, engine: cfg.model || 'unknown_model' };
  } catch (e) {
    logger.warn('AI provider validate fallback to local validator', {
      error: e.message,
    });
    return {
      valid: localIssues.length === 0,
      issues: localIssues,
      severity: localIssues.length === 0 ? 'ok' : 'warn',
      engine: 'local_fallback',
    };
  }
}

// ============================================================
// TAHAP 2: OPTIMIZE (Perbaiki performa & determinisme)
// ============================================================
export async function optimize(html, spec = {}) {
  let patchedHtml = html;
  const localChanges = [];

  if (!/renderFrame/.test(patchedHtml)) {
    const shim = `\n<script>\nwindow.renderFrame = window.renderFrame || function(t) {\n  if (window.tl && typeof window.tl.seek === 'function') window.tl.seek(t);\n};\n</script>\n`;
    patchedHtml = patchedHtml.includes('</body>')
      ? patchedHtml.replace('</body>', `${shim}</body>`)
      : patchedHtml + shim;
    localChanges.push('Injected deterministic window.renderFrame(t) shim');
  }

  if (!(await hasRiverApiKey())) {
    return {
      html: patchedHtml,
      changes: localChanges,
      engine: 'local_optimizer',
    };
  }

  try {
    const cfg = await getAiConfig();
    const result = await callDeepSeek(
      `You are an expert at optimizing HTML for headless Chromium rendering.
Return JSON: { "html": string, "changes": string[] }`,
      `Optimize this HTML for 1080p 60fps deterministic rendering.
Goals:
- Inline all CSS and JS
- Convert any CSS animations to renderFrame(t) driven
- Keep visual output IDENTICAL
- Must work with window.renderFrame(t) called per frame

Spec: ${JSON.stringify(spec)}
Original HTML:
\`\`\`html
${patchedHtml}
\`\`\`

Return the optimized HTML in the "html" field.`
    );
    return {
      html: result.html || patchedHtml,
      changes: [...localChanges, ...(result.changes || [])],
      engine: cfg.model || 'unknown_model',
    };
  } catch (e) {
    logger.warn('AI provider optimize fallback to local', { error: e.message });
    return { html: patchedHtml, changes: localChanges, engine: 'local_fallback' };
  }
}

// ============================================================
// TAHAP 3: TEST (Dry run 3 frame di Playwright Headless)
// ============================================================
export async function testRender(html, spec = {}) {
  const duration = Number(spec.duration || 10);
  const width = Number(spec.width || 1920);
  const height = Number(spec.height || 1080);

  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
    });
    const page = await browser.newPage({
      viewport: { width, height },
    });
    await applyRenderNetworkPolicy(page);

    const errors = [];
    page.on('pageerror', (e) => errors.push(`JS Error: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`Console Error: ${msg.text()}`);
    });

    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const testTimes = [0, duration / 2, Math.max(0, duration - 0.1)];
    for (const t of testTimes) {
      await page.evaluate((time) => {
        if (typeof window.renderFrame !== 'function') {
          throw new Error('window.renderFrame is not defined');
        }
        window.renderFrame(time);
      }, t);
      await page.screenshot({ type: 'jpeg', quality: 40 });
    }

    const isBlank = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (canvas) return false;
      const body = document.body;
      return !body || body.children.length === 0;
    });
    if (isBlank) {
      errors.push('Rendered page appears completely blank');
    }

    return { success: errors.length === 0, errors };
  } catch (e) {
    return { success: false, errors: [`Fatal Playwright Error: ${e.message}`] };
  } finally {
    if (browser) await browser.close();
  }
}

// ============================================================
// TAHAP 4: FIX (Auto-healing retry loop via DeepSeek-V4.1-Flash)
// ============================================================
export async function fix(html, errors, spec = {}, attempt = 1) {
  metrics.deepseekFixesTotal += 1;
  const cfg = await getAiConfig();
  const maxAttempts = Number(cfg.maxFixAttempts || 3);

  if (!(await hasRiverApiKey())) {
    let repaired = html;
    if (!/window\.renderFrame/.test(repaired)) {
      repaired += `\n<script>window.renderFrame = function(t){};</script>`;
    }
    return {
      html: repaired,
      explanation: `Local auto-repair applied on attempt ${attempt}`,
    };
  }

  try {
    return await callDeepSeek(
      `You are a debugging expert for HTML/JS motion graphics.
Return JSON: { "html": string, "explanation": string }`,
      `This HTML failed to render in Playwright. Fix it.
Attempt: ${attempt}/${maxAttempts}
Spec: ${JSON.stringify(spec)}
Errors:
${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Original HTML:
\`\`\`html
${html}
\`\`\`

Return the FIXED html in the "html" field. Ensure window.renderFrame(t) is defined and deterministic.`
    );
  } catch (e) {
    let repaired = html;
    if (!/window\.renderFrame/.test(repaired)) {
      repaired += `\n<script>window.renderFrame = function(t){};</script>`;
    }
    return {
      html: repaired,
      explanation: `Fallback auto-repair on attempt ${attempt}: ${e.message}`,
    };
  }
}

// ============================================================
// TAHAP 5: APPROVE (Pipeline Utama 5-Tahap)
// ============================================================
export async function runEngineerPipeline(rawHtml, spec = {}, onStageUpdate = () => {}) {
  const cfg = await getAiConfig();
  const maxAttempts = Number(cfg.maxFixAttempts || 3);
  const report = {
    provider: cfg.provider,
    providerId: cfg.providerId,
    model: cfg.model,
    conversationId: generateConversationId(),
    stages: [],
    attempts: 0,
    approvedHash: null,
  };

  // Stage 1: Validate
  onStageUpdate('validate');
  const validation = await validate(rawHtml, spec);
  report.stages.push({ stage: 'validate', ...validation });

  // Stage 2: Optimize
  onStageUpdate('optimize');
  const optimized = await optimize(rawHtml, spec);
  let currentHtml = optimized.html || rawHtml;
  report.stages.push({ stage: 'optimize', changes: optimized.changes });

  // Stage 3 & 4: Test & Fix Loop
  let testPassed = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    report.attempts = attempt;
    onStageUpdate(`test_attempt_${attempt}`);
    const testResult = await testRender(currentHtml, spec);
    report.stages.push({ stage: 'test', attempt, ...testResult });

    if (testResult.success) {
      testPassed = true;
      break;
    }

    logger.warn('Dry-run test failed, invoking AI provider fixer', {
      attempt,
      errors: testResult.errors,
    });

    onStageUpdate(`fix_attempt_${attempt}`);
    const fixed = await fix(currentHtml, testResult.errors, spec, attempt);
    currentHtml = fixed.html || currentHtml;
    report.stages.push({ stage: 'fix', attempt, explanation: fixed.explanation });
  }

  // Stage 5: Approve
  onStageUpdate('approve');
  const approvedHash = crypto.createHash('sha256').update(currentHtml).digest('hex');
  report.approvedHash = approvedHash;
  report.testPassed = testPassed;

  return {
    html: currentHtml,
    approvedHash,
    testPassed,
    report,
  };
}
