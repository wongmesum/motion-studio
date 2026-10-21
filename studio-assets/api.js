/**
 * Studio API client.
 *
 * The CSRF token lives in module scope for the lifetime of the page. It is never written
 * to localStorage, sessionStorage, cookies we own, or any DOM attribute, because a stored
 * token is readable by any injected script and outlives the session it protects.
 */

const SESSION_ROUTE = '/api/session';
const STUDIO_ROUTE = '/api/studio';

let csrfToken = '';
let sessionHandler = null;

export class ApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function setSessionHandler(handler) {
  sessionHandler = handler;
}

export function hasSession() {
  return csrfToken.length > 0;
}

async function readBody(response) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) return null;
  return response.json().catch(() => null);
}

/**
 * A 401 always means the session is gone rather than a bad request, so it is routed to the
 * session handler before any caller-specific error handling runs.
 */
async function request(route, { method = 'GET', body, headers = {}, signal } = {}) {
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) finalHeaders['X-CSRF-Token'] = csrfToken;

  let response;
  try {
    response = await fetch(route, {
      method,
      credentials: 'same-origin',
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('Tidak dapat menghubungi server. Periksa koneksi Anda.');
  }

  if (response.status === 401) {
    csrfToken = '';
    const unauthorized = new ApiError('Sesi berakhir. Silakan login lagi.', { status: 401 });
    if (sessionHandler) sessionHandler(unauthorized.message);
    throw unauthorized;
  }

  const payload = await readBody(response);
  if (!response.ok) {
    throw new ApiError(payload?.error || `Permintaan gagal (${response.status})`, {
      status: response.status,
      body: payload,
    });
  }
  return payload;
}

const studio = (route, options) => request(`${STUDIO_ROUTE}${route}`, options);

/** Reads the current session; resolves to null when the visitor is not authenticated. */
export async function loadSession() {
  let response;
  try {
    response = await fetch(SESSION_ROUTE, { credentials: 'same-origin' });
  } catch {
    throw new ApiError('Layanan sesi sedang tidak tersedia.');
  }
  if (response.status === 401) {
    csrfToken = '';
    return null;
  }
  if (!response.ok) throw new ApiError('Layanan sesi sedang tidak tersedia.');
  const session = await response.json();
  csrfToken = session.csrfToken || '';
  return session;
}

export async function login(password) {
  const response = await fetch(`${SESSION_ROUTE}/login`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const body = await readBody(response);
  if (response.status === 429) {
    throw new ApiError('Terlalu banyak percobaan. Coba lagi nanti.', { status: 429 });
  }
  if (!response.ok) {
    throw new ApiError(body?.error || 'Password tidak valid.', { status: response.status });
  }
  csrfToken = body.csrfToken || '';
  return body;
}

export async function logout() {
  try {
    await request(`${SESSION_ROUTE}/logout`, { method: 'POST' });
  } finally {
    csrfToken = '';
  }
}

export const listTemplates = () => studio('/templates');
/** Provider + model catalog. Carries ids only; the API key never leaves the server. */
export const listAiModels = () => studio('/models');
export const generateScene = (prompt, providerId, model) =>
  studio('/prompt', {
    method: 'POST',
    // An omitted model keeps the provider's configured default.
    body: { prompt, providerId, ...(model ? { model } : {}) },
  });
export const compileProject = (project, { useAiHtml = false, signal } = {}) =>
  studio('/projects/compile', { method: 'POST', body: { project, useAiHtml }, signal });
export const submitRender = (project, { useAiHtml = false } = {}) =>
  studio('/render', { method: 'POST', body: { project, useAiHtml } });
export const fetchJob = (jobId) => studio(`/jobs/${encodeURIComponent(jobId)}`);
export const listAssets = () => studio('/assets');
export const deleteAsset = (assetId) => studio(`/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
export const assetContentUrl = (assetId) => `${STUDIO_ROUTE}/assets/${encodeURIComponent(assetId)}/content`;
export const listProjects = () => studio('/projects');
export const deleteProject = (projectId) =>
  studio(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
export const createProject = (project) => studio('/projects', { method: 'POST', body: { project } });
export const saveProject = (project, baseRevision) =>
  studio(`/projects/${encodeURIComponent(project.projectId)}`, {
    method: 'PUT',
    body: { baseRevision, project },
  });
export const loadProject = (projectId) => studio(`/projects/${encodeURIComponent(projectId)}`);
export const validateProject = (project) =>
  studio('/projects/validate', { method: 'POST', body: { project } });

/**
 * Streams one file to the upload endpoint. `fetch` with a FormData body would need the
 * browser to buffer the whole part, so uploads deliberately avoid it and use XHR, whose
 * progress events also drive the per-file percentage in the asset library.
 */
export function uploadAsset(file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${STUDIO_ROUTE}/assets`);
    xhr.withCredentials = true;
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    });

    xhr.addEventListener('load', () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status === 401) {
        csrfToken = '';
        const message = 'Sesi berakhir. Silakan login lagi.';
        if (sessionHandler) sessionHandler(message);
        reject(new ApiError(message, { status: 401 }));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(body?.error || `Upload gagal (${xhr.status})`, {
          status: xhr.status,
          body,
        }));
        return;
      }
      resolve(body);
    });

    xhr.addEventListener('error', () => reject(new ApiError('Upload gagal: koneksi terputus.')));
    xhr.addEventListener('abort', () => reject(new ApiError('Upload dibatalkan.')));
    xhr.send(form);
  });
}
