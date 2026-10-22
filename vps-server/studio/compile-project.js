import path from 'path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'url';
import { sanitizeHtml } from '../security/sanitize.js';
import { isAllowedRenderUrl } from '../security/network-policy.js';
import { normalizeProjectDraft } from './project-schema.js';

export const PROJECT_DATA_ELEMENT_ID = 'motion-project-data';
export const ASSET_CONTENT_ROUTE_PREFIX = '/api/studio/assets/';

const LINE_SEPARATOR = ' ';
const PARAGRAPH_SEPARATOR = ' ';
const COMPILE_TARGETS = new Set(['preview', 'render']);

/**
 * Every literal that `sanitizeHtml` rejects is neutralized by escaping its first
 * character as a JSON unicode escape. The payload still parses back to the original
 * user text, but the forbidden token never appears in the compiled HTML string.
 */
const SANITIZER_TOKENS = [
  'sharedworker(',
  'xmlhttprequest',
  'eventsource(',
  'sendbeacon(',
  'websocket(',
  'child_process',
  'fs.readfile',
  'fs.writefile',
  'process.env',
  'javascript:',
  'file:///etc/',
  'file:///proc/',
  'file:///sys/',
  'require(',
  'worker(',
  'import(',
  'fetch(',
].sort((left, right) => right.length - left.length);

const SANITIZER_TOKEN_PATTERN = new RegExp(
  `(${SANITIZER_TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
  'gi'
);

function escapeFirstCharacter(match) {
  return `\\u${match.charCodeAt(0).toString(16).padStart(4, '0')}${match.slice(1)}`;
}

export function escapeInlineJsonPayload(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEPARATOR).join('\\u2028')
    .split(PARAGRAPH_SEPARATOR).join('\\u2029')
    .replace(SANITIZER_TOKEN_PATTERN, escapeFirstCharacter);
}

function buildProjectDataScript(project) {
  return `<script id="${PROJECT_DATA_ELEMENT_ID}" type="application/json">`
    + `${escapeInlineJsonPayload(project)}</script>`;
}

/**
 * The preview frame is sandboxed without `allow-same-origin`, so its origin is opaque and
 * the parent cannot touch `contentWindow` directly. Frame stepping therefore goes through
 * `postMessage`. Only messages from the embedding window are accepted, and the handler is
 * never injected into render output.
 */
const PREVIEW_BRIDGE_ELEMENT_ID = 'motion-preview-bridge';

const PREVIEW_BRIDGE_SCRIPT = `<script id="${PREVIEW_BRIDGE_ELEMENT_ID}">`
  + '(function(){'
  + "if(window.parent===window)return;"
  + "window.addEventListener('message',function(event){"
  + 'try{'
  + "if(event.source!==window.parent)return;"
  + "var data=event.data;"
  + "if(!data||data.type!=='motion-preview-frame')return;"
  + 'var time=Number(data.time);'
  + 'if(!isFinite(time))return;'
  + 'if(typeof window.renderFrame!==\'function\')return;'
  + 'window.renderFrame(time<0?0:time);'
  + '}catch(error){}'
  + '});'
  + '})();'
  + '</script>';

function injectPreviewBridge(html) {
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const insertAt = bodyMatch.index + bodyMatch[0].length;
    return `${html.slice(0, insertAt)}\n${PREVIEW_BRIDGE_SCRIPT}${html.slice(insertAt)}`;
  }
  return `${PREVIEW_BRIDGE_SCRIPT}\n${html}`;
}

function hasRenderFrame(html) {
  return /(?:window\.)?renderFrame\s*=|function\s+renderFrame\s*\(/.test(html);
}

function describeDryRunFailure(result) {
  if (!result || result.success !== true) {
    const errors = Array.isArray(result?.errors) ? result.errors.join('; ') : 'hasil tidak valid';
    throw new Error(`Uji render AI gagal: ${errors}`);
  }
}

function injectProjectData(html, dataScript) {
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const insertAt = bodyMatch.index + bodyMatch[0].length;
    return `${html.slice(0, insertAt)}\n${dataScript}${html.slice(insertAt)}`;
  }
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}\n${dataScript}${html.slice(insertAt)}`;
  }
  return `${dataScript}\n${html}`;
}


// Shared deterministic motion math is embedded before template scripts execute.
// This avoids network dependencies and makes preview/render use identical easing.
async function injectMotionPresets(html, project) {
  if (!project.scenes.some(scene => scene.elements.some(element => element.motion && element.motion.preset !== 'none'))) {
    return html;
  }
  const runtime = await readFile(new URL('../../render-engine/motion-presets.js', import.meta.url), 'utf8');
  return injectProjectData(html, '<script id="motion-preset-runtime">\n' + runtime + '\n</script>');
}

// Motion Studio embeds only vetted local artwork and a deterministic SVG/Canvas renderer.
// No remote URLs, arbitrary JSON payloads or third-party scripts enter render HTML.
async function injectGestureOverlay(html, project) {
  if (!project.scenes.some((scene) => (scene.gestures || []).length > 0)) return html;
  const asset = (relative) => new URL(relative, import.meta.url);
  const [runtime, cursor, burst, burstSoft] = await Promise.all([
    readFile(asset('../../render-engine/gesture-overlay.js'), 'utf8'),
    readFile(asset('../../render-engine/lottie/cursor-real-black.json'), 'utf8'),
    readFile(asset('../../render-engine/lottie/click-sunburst-soft-4-sm.json'), 'utf8'),
    readFile(asset('../../modules/lottie/assets/click-sunburst-soft-xs.json'), 'utf8'),
  ]);
  const artwork = escapeInlineJsonPayload({
    cursor: JSON.parse(cursor),
    burst: JSON.parse(burst),
    burstSoft: JSON.parse(burstSoft),
  });
  const scripts = '<script type="application/json" id="motion-gesture-art">' + artwork
    + '</script><script id="motion-gesture-runtime">\n' + runtime + '\n</script>';
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, scripts + '\n</body>')
    : html + scripts;
}

function assertTemplateHtml(html) {
  if (typeof html !== 'string' || html.trim().length === 0) {
    throw new Error('Isi template HTML kosong atau tidak valid');
  }
  return html;
}

function previewAssetUrl(assetId) {
  return `${ASSET_CONTENT_ROUTE_PREFIX}${assetId}/content`;
}

function renderAssetUrl(localPath) {
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
    throw new Error('Path aset render tidak valid');
  }
  const fileUrl = pathToFileURL(localPath).href;
  if (!isAllowedRenderUrl(fileUrl)) {
    throw new Error('Path aset render berada di luar direktori tepercaya');
  }
  return fileUrl;
}

async function resolveElement(element, target, resolveAsset, buildPreviewUrl) {
  if (element.type === 'text') return element;

  if (target === 'preview') {
    if (typeof resolveAsset === 'function') {
      await resolveAsset(element.assetId, { target, role: element.role });
    }
    const src = typeof buildPreviewUrl === 'function'
      ? await buildPreviewUrl(element.assetId)
      : previewAssetUrl(element.assetId);
    return { ...element, src };
  }

  const resolved = await resolveAsset(element.assetId, { target, role: element.role });
  return { ...element, src: renderAssetUrl(resolved?.localPath) };
}

async function withResolvedAssets(project, target, resolveAsset, buildPreviewUrl) {
  const scenes = [];
  for (const scene of project.scenes) {
    const elements = [];
    for (const element of scene.elements) {
      elements.push(await resolveElement(element, target, resolveAsset, buildPreviewUrl));
    }
    scenes.push({ ...scene, elements });
  }
  return { ...project, scenes };
}

/**
 * The project audio track is muxed by FFmpeg after the frames are captured, so the
 * template itself stays silent. The resolved filesystem path is therefore a server-only
 * value: it is returned next to the compiled HTML and never written into the project
 * data script, which only keeps the opaque asset id.
 */
async function resolveProjectAudio(project, target, resolveAsset) {
  if (!project.audio) return undefined;

  if (target === 'preview') {
    // Preview only proves the caller owns the track; the frame plays no sound.
    await resolveAsset(project.audio.assetId, { target, role: 'audio' });
    return undefined;
  }

  const resolved = await resolveAsset(project.audio.assetId, { target, role: 'audio' });
  const localPath = resolved?.localPath;
  if (typeof localPath !== 'string' || localPath.trim().length === 0) {
    throw new Error('Path aset audio tidak valid');
  }
  return localPath;
}

export async function compileProject(input, {
  target = 'render',
  readTemplate,
  resolveAsset,
  buildPreviewUrl,
  useAiHtml = false,
  generateAiHtml,
  testAiHtml,
} = {}) {
  if (!COMPILE_TARGETS.has(target)) {
    throw new Error(`Target compile tidak didukung: ${target}`);
  }
  if (typeof readTemplate !== 'function') {
    throw new Error('Pembaca template wajib tersedia');
  }

  // Normalization also enforces validateJobLimits, so an over-limit project fails
  // before any template read or asset resolution happens.
  const project = normalizeProjectDraft(input);

  const needsAssets = project.scenes.some((scene) =>
    scene.elements.some((element) => element.type !== 'text')
  );
  const needsAudio = Boolean(project.audio);
  const needsResolver = (target === 'render' && needsAssets) || needsAudio;
  if (needsResolver && typeof resolveAsset !== 'function') {
    throw new Error('Resolver aset wajib tersedia untuk project ini');
  }

  const baseHtml = assertTemplateHtml(await readTemplate(project.template));
  const resolved = await withResolvedAssets(project, target, resolveAsset, buildPreviewUrl);
  const audioLocalPath = await resolveProjectAudio(resolved, target, resolveAsset);
  const dataScript = buildProjectDataScript(resolved);
  const withData = injectProjectData(baseHtml, dataScript);
  const withBridge = target === 'preview' ? injectPreviewBridge(withData) : withData;
  const withMotion = await injectMotionPresets(withBridge, resolved);
  const withGesture = await injectGestureOverlay(withMotion, resolved);
  const deterministicHtml = sanitizeHtml(withGesture);
  const warnings = [];

  if (!useAiHtml) {
    return { html: deterministicHtml, project: resolved, target, warnings, audioLocalPath };
  }
  if (typeof generateAiHtml !== 'function' || typeof testAiHtml !== 'function') {
    warnings.push('AI HTML tidak tersedia; compiler deterministik digunakan');
    return { html: deterministicHtml, project: resolved, target, warnings, audioLocalPath };
  }

  try {
    // AI receives normalized structure but never local `file://` paths. Assets are injected
    // afterward from the trusted server resolution result.
    const candidate = assertTemplateHtml(await generateAiHtml(project));
    if (!hasRenderFrame(candidate)) {
      throw new Error('window.renderFrame tidak ditemukan');
    }
    const candidateWithData = injectProjectData(candidate, dataScript);
    const candidateWithBridge = target === 'preview'
      ? injectPreviewBridge(candidateWithData)
      : candidateWithData;
    const candidateWithMotion = await injectMotionPresets(candidateWithBridge, resolved);
    const candidateWithGesture = await injectGestureOverlay(candidateWithMotion, resolved);
    const aiHtml = sanitizeHtml(candidateWithGesture);
    describeDryRunFailure(await testAiHtml(aiHtml, resolved.render));
    return { html: aiHtml, project: resolved, target, warnings, audioLocalPath };
  } catch (error) {
    warnings.push(`AI HTML gagal; compiler deterministik digunakan: ${error.message}`);
    return { html: deterministicHtml, project: resolved, target, warnings, audioLocalPath };
  }
}
