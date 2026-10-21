import { callAiChat, hasRiverApiKey } from '../deepseek-engineer.js';
import { extractJsonObject } from './json-extract.js';
import { normalizeProjectDraft } from './project-schema.js';

const MAX_PROMPT_CHARS = 4000;
const MAX_AI_TOKENS = 4096;
const SYSTEM_PROMPT = `You create editable scene JSON for Motion Studio.
Return one JSON object only. Never return HTML, markdown, explanations, or code fences.
Use this shape:
{
  "title": string,
  "template": "base" | "kinetic-text" | "image-slideshow" | "video-mixer",
  "render": { "duration": number, "fps": number, "width": number, "height": number, "codec": "h264" },
  "theme": { "backgroundColor": "#RRGGBB", "primaryColor": "#RRGGBB", "accentColor": "#RRGGBB", "fontFamily": string },
  "scenes": [{
    "durationSec": number,
    "transition": { "type": "fade" | "slide" | "none", "durationSec": number },
    "elements": [{
      "type": "text" | "image" | "video",
      "role": "title" | "subtitle" | "caption" | "background" | "pip" | "logo",
      "text": string,
      "assetId": string
    }]
  }]
}
Text elements may omit assetId. Image and video elements should only use asset IDs explicitly included in the user prompt; otherwise use text placeholders. Keep all user-visible copy in Indonesian unless requested otherwise. Maximum 20 scenes and 20 elements per scene.`;

export class PromptUnavailableError extends Error {
  constructor(message = 'Provider AI belum dikonfigurasi') {
    super(message);
    this.name = 'PromptUnavailableError';
  }
}

export class SceneAiOutputError extends Error {
  constructor(message = 'Struktur scene AI tidak valid') {
    super(message);
    this.name = 'SceneAiOutputError';
  }
}

function normalizePrompt(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Prompt wajib diisi');
  }
  const prompt = value.trim();
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt maksimal ${MAX_PROMPT_CHARS} karakter`);
  }
  return prompt;
}

/**
 * Deliberately has no `model` option: the model picker in the prompt panel applies only to
 * scene-structure generation. This path is the render-time HTML rewrite and keeps using the
 * provider's configured default so a render never depends on a browser-side selection.
 */
export async function generateProjectHtml(project, {
  providerId,
  callChat = callAiChat,
  hasApiKey = (candidateProvider) => hasRiverApiKey(undefined, candidateProvider),
} = {}) {
  if (!(await hasApiKey(providerId))) {
    throw new PromptUnavailableError();
  }

  const response = await callChat({
    providerId,
    messages: [
      {
        role: 'system',
        content: `Create one self-contained deterministic HTML document for Playwright video rendering.
Return raw HTML only, no markdown fence. Define window.renderFrame(timeSeconds). Do not use network APIs,
external URLs, timers, dynamic import, or Node.js APIs. Read scene data from the JSON script element
with id "motion-project-data". Render all user text through textContent or canvas fillText, never innerHTML.`,
      },
      { role: 'user', content: JSON.stringify(project) },
    ],
    temperature: 0.2,
    maxTokens: MAX_AI_TOKENS,
    enableThinking: false,
    stream: false,
  });
  const html = String(response?.content || '')
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!html) throw new SceneAiOutputError('AI tidak menghasilkan HTML');
  return html;
}

export async function generateSceneDraft(promptInput, {
  providerId,
  model,
  callChat = callAiChat,
  hasApiKey = (candidateProvider) => hasRiverApiKey(undefined, candidateProvider),
} = {}) {
  const prompt = normalizePrompt(promptInput);
  if (!(await hasApiKey(providerId))) {
    throw new PromptUnavailableError();
  }

  let response;
  try {
    response = await callChat({
      providerId,
      // Omitted model keeps the provider's configured default; the router has already
      // checked any explicit id against the registry allowlist.
      ...(model ? { model } : {}),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens: MAX_AI_TOKENS,
      enableThinking: false,
      stream: false,
    });
  } catch (error) {
    throw new PromptUnavailableError(`Provider AI tidak tersedia: ${error.message}`);
  }

  try {
    const extracted = extractJsonObject(response?.content);
    return {
      project: normalizeProjectDraft(extracted),
      providerId: response?.providerId || providerId || 'unknown',
      model: response?.model || 'unknown',
    };
  } catch (error) {
    throw new SceneAiOutputError(`Struktur scene AI tidak valid: ${error.message}`);
  }
}
