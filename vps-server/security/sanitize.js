import { getAllowedRenderHosts, isAllowedRenderUrl } from './network-policy.js';

const URL_ATTRIBUTE_PATTERN = /<(script|img|video|audio|source|link|iframe)\b[^>]*?\b(src|href)\s*=\s*(["'])(.*?)\3/gi;
const BASE_TAG_PATTERN = /<base\b[^>]*>/i;

function validateExternalResources(html) {
  const allowedHosts = getAllowedRenderHosts();
  let match;
  URL_ATTRIBUTE_PATTERN.lastIndex = 0;

  while ((match = URL_ATTRIBUTE_PATTERN.exec(html)) !== null) {
    const [, tagName, attributeName, , rawUrl] = match;
    const isScriptSource = tagName.toLowerCase() === 'script' && attributeName.toLowerCase() === 'src';

    if (/^(data:|blob:)/i.test(rawUrl) && isScriptSource) {
      throw new Error('Security policy violation: script src cannot use data: or blob: URLs');
    }
    if (!isAllowedRenderUrl(rawUrl, allowedHosts)) {
      throw new Error(`Security policy violation: resource URL is not allowed: ${rawUrl.slice(0, 120)}`);
    }
  }
}

/**
 * Sanitasi HTML sebelum dieksekusi di Playwright Headless.
 * Network interception tetap menjadi enforcement layer utama saat render.
 */
export function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') {
    throw new Error('HTML content is required and must be a string');
  }

  const maxBytes = Number(process.env.MAX_HTML_BYTES || 500_000);
  if (Buffer.byteLength(html, 'utf8') > maxBytes) {
    throw new Error(`HTML too large (>${maxBytes} bytes)`);
  }

  const forbiddenPatterns = [
    { regex: BASE_TAG_PATTERN, reason: '<base> tag is forbidden' },
    { regex: /\bimport\s*\(/i, reason: 'Dynamic import() is forbidden' },
    { regex: /\bWebSocket\s*\(/i, reason: 'WebSocket is forbidden' },
    { regex: /\bnavigator\.sendBeacon\s*\(/i, reason: 'sendBeacon is forbidden' },
    { regex: /\bXMLHttpRequest\b/i, reason: 'XMLHttpRequest is forbidden' },
    { regex: /\bfetch\s*\(/i, reason: 'fetch() is forbidden inside render templates' },
    { regex: /\b(EventSource|SharedWorker|Worker)\s*\(/i, reason: 'Background network workers are forbidden' },
    { regex: /(?:\brequire\s*\(|\bchild_process\b|\bfs\.readFile\b|\bfs\.writeFile\b|\bprocess\.env\b)/i, reason: 'Node.js runtime access patterns are forbidden' },
    { regex: /file:\/\/(?:\/)?(?:etc|proc|sys)\//i, reason: 'Local system file access is forbidden' },
    { regex: /(?:src|href)\s*=\s*["']\s*javascript:/i, reason: 'javascript: URLs are forbidden' },
  ];

  for (const item of forbiddenPatterns) {
    if (item.regex.test(html)) {
      throw new Error(`Security policy violation: ${item.reason}`);
    }
  }

  validateExternalResources(html);
  return html;
}
