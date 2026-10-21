const FORBIDDEN_KEYS = new Set(['localPath', 'src']);
const WINDOWS_PATH_PATTERN = /[a-zA-Z]:[\\/]/;

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !FORBIDDEN_KEYS.has(key))
      .map(([key, nestedValue]) => [key, sanitizeValue(nestedValue)])
  );
}

function assertBrowserSafeJson(serialized) {
  if (/file:\/\//i.test(serialized) || WINDOWS_PATH_PATTERN.test(serialized)) {
    throw new Error('Project memuat path lokal yang tidak aman.');
  }
}

export function serializeProject(project) {
  const safeProject = sanitizeValue(project);
  const serialized = JSON.stringify(safeProject, null, 2);
  assertBrowserSafeJson(serialized);
  return serialized;
}

export function parseProjectJson(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('File project bukan JSON yang valid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Project harus berupa objek JSON.');
  }
  return parsed;
}

export function downloadProject(project, { document: doc = document, url = URL } = {}) {
  const serialized = serializeProject(project);
  const blobUrl = url.createObjectURL(new Blob([serialized], { type: 'application/json' }));
  const link = doc.createElement('a');
  const safeTitle = (project.title || 'motion-studio-project')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'motion-studio-project';
  link.href = blobUrl;
  link.download = `${safeTitle}.json`;
  link.click();
  url.revokeObjectURL(blobUrl);
}

export async function importProjectFile(file, validateProject) {
  if (!file) throw new Error('Pilih file project JSON.');
  const source = await file.text();
  const draft = parseProjectJson(source);
  delete draft.projectId;
  const validated = await validateProject(draft);
  const importedProject = { ...validated.project };
  delete importedProject.projectId;
  return importedProject;
}
