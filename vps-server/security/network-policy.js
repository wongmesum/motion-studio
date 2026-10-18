import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_ALLOWED_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
];

function parseTrustedAssetDirectories() {
  const defaults = [
    path.resolve(process.cwd(), 'cache'),
    path.resolve(process.cwd(), 'render-engine'),
    path.resolve(process.cwd(), 'frames'),
  ];
  const configured = String(process.env.RENDER_ALLOWED_FILE_DIRS || '')
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean)
    .map((directory) => path.resolve(directory));
  return [...defaults, ...configured];
}

function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseConfiguredHosts() {
  return String(process.env.RENDER_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function getAllowedRenderHosts() {
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...parseConfiguredHosts()]);
}

export function isAllowedRenderUrl(rawUrl, allowedHosts = getAllowedRenderHosts()) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  const value = rawUrl.trim();
  if (/^(data:|blob:|about:blank$)/i.test(value)) return true;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol === 'file:') {
    try {
      const localPath = path.resolve(fileURLToPath(parsed));
      return parseTrustedAssetDirectories().some((directory) =>
        isPathInside(localPath, directory)
      );
    } catch {
      return false;
    }
  }

  return parsed.protocol === 'https:' && allowedHosts.has(parsed.hostname.toLowerCase());
}

export function isAllowedRemoteAssetUrl(rawUrl, allowedHosts = getAllowedRenderHosts()) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'https:' && allowedHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function applyRenderNetworkPolicy(page) {
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (isAllowedRenderUrl(requestUrl)) {
      await route.continue();
      return;
    }
    await route.abort('blockedbyclient');
  });
}
