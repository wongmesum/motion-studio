import axios from 'axios';
import crypto from 'crypto';

const PROVIDERS = {
  river: {
    name: 'River AI',
    docsUrl: 'https://console.river.ai/keys',
    baseUrl: process.env.RIVER_API_BASE_URL || 'https://api.river.ai',
    apiKey: process.env.RIVER_API_KEY || '',
    model: process.env.RIVER_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash',
  },
  deepseek: {
    name: 'DeepSeek Official',
    docsUrl: 'https://api-docs.deepseek.com/',
    baseUrl: process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
};

function getProviderConfig() {
  const providerId = process.env.AI_PROVIDER || 'river';
  const config = PROVIDERS[providerId];
  if (!config) throw new Error(`Unsupported AI provider: ${providerId}`);
  return { ...config, providerId };
}

function buildCompletionsEndpoint(baseUrl) {
  const clean = String(baseUrl).trim().replace(/\/+$/, '');
  if (clean.endsWith('/v1/chat/completions')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

export function buildProviderRequest(config, messages, conversationId) {
  const body = {
    model: config.model,
    stream: true,
    temperature: 0.7,
    max_tokens: 2048,
    messages,
  };
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  if (config.providerId === 'river') {
    body.chat_template_kwargs = { enable_thinking: false };
    headers['X-River-Conversation-Id'] = conversationId;
  }

  return { body, headers };
}

function parseSseOrJson(raw) {
  if (typeof raw !== 'string') {
    return raw?.choices?.[0]?.message?.content || JSON.stringify(raw);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && !trimmed.startsWith('data:')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.choices?.[0]?.message?.content) return parsed.choices[0].message.content;
    } catch {
      // Continue with SSE parsing because some providers return mixed payloads.
    }
  }

  let combined = '';
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean.startsWith('data:')) continue;
    const payload = clean.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      const delta =
        chunk?.choices?.[0]?.delta?.content ??
        chunk?.choices?.[0]?.message?.content ??
        '';
      if (delta) combined += delta;
    } catch {
      // Ignore malformed SSE keep-alive lines.
    }
  }
  return combined || trimmed;
}

function isConfiguredApiKey(apiKey) {
  return Boolean(
    apiKey &&
      apiKey !== 'your_deepseek_api_key_here' &&
      apiKey !== 'your_river_api_key_here'
  );
}

function parseModelResponse(content, fallbackHtml, provider) {
  const cleaned = String(content)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const metadata = {
    provider: provider.name,
    providerId: provider.providerId,
    model: provider.model,
  };

  try {
    return { ...JSON.parse(cleaned), ...metadata };
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return { ...JSON.parse(match[0]), ...metadata };
    return { html: fallbackHtml, explanation: cleaned, ...metadata };
  }
}

/**
 * Ask selected AI provider to create or repair deterministic motion HTML.
 */
export async function askDeepSeek({ html = '', error = '', goal = '' }) {
  const provider = getProviderConfig();
  if (!isConfiguredApiKey(provider.apiKey)) {
    return {
      mode: 'local_heuristic_fallback',
      provider: `${provider.name} (${provider.docsUrl})`,
      providerId: provider.providerId,
      model: provider.model,
      explanation: `API key ${provider.name} belum diisi; menggunakan generator template deterministik lokal.`,
      html: html || generateFallbackHtml(goal),
    };
  }

  const conversationId = crypto.randomUUID().toLowerCase();
  const systemPrompt = `You are a Senior Motion Graphics Render Engineer powered by ${provider.model}.
Your task is to generate or fix HTML5/Canvas/GSAP animations for deterministic frame-by-frame rendering in Playwright at 1920x1080 60fps.
Rules:
1. Must expose window.renderFrame = function(timeInSeconds) { ... }
2. Never rely on setInterval/setTimeout or uncontrolled CSS infinite animations; calculate all visual states deterministically from timeInSeconds.
3. Inline all CSS and scripts (except trusted CDNs like cdn.jsdelivr.net for GSAP).
4. Return valid JSON: { "html": "<!DOCTYPE html>...", "explanation": "..." }`;
  const userPrompt = `Goal: ${goal}
${error ? `Previous Render Error:\n${error}\n` : ''}
${html ? `Current HTML:\n\`\`\`html\n${html}\n\`\`\`` : 'Generate a brand new deterministic 1080p HTML animation.'}`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const request = buildProviderRequest(provider, messages, conversationId);
  const response = await axios.post(
    buildCompletionsEndpoint(provider.baseUrl),
    request.body,
    {
      headers: request.headers,
      responseType: 'text',
      timeout: 60000,
    }
  );
  const fallbackHtml = html || generateFallbackHtml(goal);
  return {
    ...parseModelResponse(parseSseOrJson(response.data), fallbackHtml, provider),
    conversationId,
  };
}

function generateFallbackHtml(goal = 'Motion Studio') {
  const safeTitle = String(goal).replace(/[<>&"']/g, '').slice(0, 40) || 'MOTION 2026';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; background: #0a0a14; font-family: sans-serif; }
  canvas { display: block; }
</style>
</head>
<body>
<canvas id="c" width="1920" height="1080"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
window.renderFrame = function(t) {
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(0, 0, 1920, 1080);
  const hue = (t * 45) % 360;
  ctx.fillStyle = 'hsl(' + hue + ', 85%, 60%)';
  ctx.font = 'bold 96px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('${safeTitle}', 960, 540 + Math.sin(t * 3) * 30);
};
window.renderFrame(0);
</script>
</body>
</html>`;
}
