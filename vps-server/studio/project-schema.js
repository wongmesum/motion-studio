import crypto from 'crypto';
import { JOB_LIMITS, validateJobLimits } from '../middleware/limits.js';

export const PROJECT_SCHEMA_VERSION = 1;

export const PROJECT_LIMITS = {
  maxScenes: 20,
  maxElementsPerScene: 20,
  maxTitleChars: 120,
  maxTextChars: 500,
  maxElementTextTotal: 20_000,
  maxFontSize: 240,
  minFontSize: 12,
  maxThemeChars: 64,
  maxTemplateChars: 64,
  maxDurationSec: 600,
  maxTitleScenesChars: 200,
};

export const ELEMENT_TYPES = Object.freeze(['text', 'image', 'video']);
export const MOTION_PRESETS = Object.freeze(['none', 'fade-in', 'slide-up', 'slide-left', 'zoom-in']);
export const ELEMENT_ROLES = Object.freeze(['title', 'subtitle', 'caption', 'background', 'pip', 'logo']);
export const TRANSITION_TYPES = Object.freeze(['fade', 'slide', 'none']);
export const ALIGNMENTS = Object.freeze(['left', 'center', 'right']);
export const FITS = Object.freeze(['cover', 'contain']);
export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
// Asset ids are server-generated and opaque; anything path-like is rejected here so
// the compiler never has to reason about user-controlled filesystem input.
export const ASSET_ID_PATTERN = /^ast_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SCENE_ID_PATTERN = /^scn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ELEMENT_ID_PATTERN = /^el_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PROJECT_ID_PATTERN = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DEFAULT_RENDER = Object.freeze({
  duration: 10,
  fps: 30,
  width: 1280,
  height: 720,
  codec: 'h264',
});

const DEFAULT_THEME = Object.freeze({
  backgroundColor: '#070913',
  primaryColor: '#38bdf8',
  accentColor: '#a855f7',
  fontFamily: 'Inter',
});

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function assertString(value, message, maxChars) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message);
  if (maxChars !== undefined && value.length > maxChars) throw new Error(message);
  return value;
}

function normalizeColor(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    throw new Error(`Warna ${label} tidak valid`);
  }
  return value.toLowerCase();
}

function normalizeUnit(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Posisi ${label} harus angka 0..1`);
  }
  return value;
}

function normalizeEnum(value, fallback, allowed, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${label} tidak valid`);
  }
  return value;
}

function normalizeTheme(theme) {
  const source = theme && typeof theme === 'object' ? theme : {};
  return {
    backgroundColor: normalizeColor(source.backgroundColor, DEFAULT_THEME.backgroundColor, 'latar'),
    primaryColor: normalizeColor(source.primaryColor, DEFAULT_THEME.primaryColor, 'utama'),
    accentColor: normalizeColor(source.accentColor, DEFAULT_THEME.accentColor, 'aksen'),
    fontFamily: source.fontFamily === undefined
      ? DEFAULT_THEME.fontFamily
      : assertString(source.fontFamily, 'Font tidak valid', PROJECT_LIMITS.maxThemeChars),
  };
}

/** Sums the scene timeline, which is the single source of truth for the render length. */
export function sumSceneDurations(scenes) {
  return (Array.isArray(scenes) ? scenes : []).reduce(
    (total, scene) => total + (Number(scene?.durationSec) || 0),
    0
  );
}

function normalizeRender(render) {
  const source = render && typeof render === 'object' ? render : {};
  return {
    // `duration` is derived from the scenes after normalization; the client value is
    // ignored here so a stale form field can never disagree with the timeline.
    duration: DEFAULT_RENDER.duration,
    fps: source.fps === undefined ? DEFAULT_RENDER.fps : source.fps,
    width: source.width === undefined ? DEFAULT_RENDER.width : source.width,
    height: source.height === undefined ? DEFAULT_RENDER.height : source.height,
    codec: source.codec === undefined ? DEFAULT_RENDER.codec : String(source.codec).toLowerCase(),
  };
}

function normalizeTransition(transition) {
  const source = transition && typeof transition === 'object' ? transition : {};
  const durationSec = source.durationSec === undefined ? 0.5 : source.durationSec;
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec < 0 || durationSec > 10) {
    throw new Error('Durasi transisi tidak valid');
  }
  return {
    type: normalizeEnum(source.type, 'fade', TRANSITION_TYPES, 'Transisi'),
    durationSec,
  };
}

function normalizeAssetId(value) {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) {
    throw new Error('ID aset tidak valid');
  }
  return value;
}

function normalizeAudio(audio) {
  if (audio === undefined || audio === null) return null;
  if (typeof audio !== 'object' || Array.isArray(audio)) {
    throw new Error('Audio project tidak valid');
  }
  return { assetId: normalizeAssetId(audio.assetId) };
}

function normalizeMotion(motion) {
  if (motion === undefined || motion === null) return undefined;
  if (!motion || typeof motion !== 'object' || Array.isArray(motion)) throw new Error('Animasi tidak valid');
  const preset = normalizeEnum(motion.preset, 'none', MOTION_PRESETS, 'Animasi');
  const startSec = motion.startSec === undefined ? 0 : motion.startSec;
  const durationSec = motion.durationSec === undefined ? 0.8 : motion.durationSec;
  if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0 || startSec > 600) throw new Error('Waktu mulai animasi tidak valid');
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 60) throw new Error('Durasi animasi tidak valid');
  return { preset, startSec, durationSec };
}

function normalizeTextElement(element, textBudget) {
  const text = assertString(element.text ?? '', 'Teks elemen tidak valid', PROJECT_LIMITS.maxTextChars);
  if (textBudget.used + text.length > PROJECT_LIMITS.maxElementTextTotal) {
    throw new Error('Total teks project melebihi batas');
  }
  textBudget.used += text.length;

  const fontSize = element.fontSize === undefined ? 64 : element.fontSize;
  if (!Number.isInteger(fontSize)
    || fontSize < PROJECT_LIMITS.minFontSize
    || fontSize > PROJECT_LIMITS.maxFontSize) {
    throw new Error('Ukuran font tidak valid');
  }

  return {
    id: normalizeId(element.id, ELEMENT_ID_PATTERN, 'el'),
    type: 'text',
    role: normalizeEnum(element.role, 'title', ELEMENT_ROLES, 'Role'),
    text,
    x: normalizeUnit(element.x, 0.08, 'x'),
    y: normalizeUnit(element.y, 0.42, 'y'),
    width: normalizeUnit(element.width, 0.84, 'width'),
    fontSize,
    color: normalizeColor(element.color, '#f1f5f9', 'teks'),
    align: normalizeEnum(element.align, 'left', ALIGNMENTS, 'Align'),
    ...(normalizeMotion(element.motion) ? { motion: normalizeMotion(element.motion) } : {}),
  };
}

function normalizeVisualElement(element, type) {
  return {
    id: normalizeId(element.id, ELEMENT_ID_PATTERN, 'el'),
    type,
    role: normalizeEnum(element.role, type === 'video' ? 'pip' : 'background', ELEMENT_ROLES, 'Role'),
    assetId: normalizeAssetId(element.assetId),
    fit: normalizeEnum(element.fit, 'cover', FITS, 'Fit'),
    kenBurns: Boolean(element.kenBurns),
    x: normalizeUnit(element.x, 0, 'x'),
    y: normalizeUnit(element.y, 0, 'y'),
    width: normalizeUnit(element.width, 1, 'width'),
    ...(normalizeMotion(element.motion) ? { motion: normalizeMotion(element.motion) } : {}),
    ...(type === 'video'
      ? {
        muted: element.muted === undefined ? true : Boolean(element.muted),
        loop: element.loop === undefined ? true : Boolean(element.loop),
      }
      : {}),
  };
}

function normalizeId(value, pattern, prefix) {
  if (value === undefined) return createId(prefix);
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('ID tidak valid');
  }
  return value;
}

function normalizeElement(element, textBudget) {
  const type = normalizeEnum(element?.type, undefined, ELEMENT_TYPES, 'Tipe elemen');
  if (type === 'text') return normalizeTextElement(element, textBudget);
  return normalizeVisualElement(element, type);
}

function normalizeScene(scene, textBudget) {
  const elements = Array.isArray(scene?.elements) ? scene.elements : [];
  if (elements.length > PROJECT_LIMITS.maxElementsPerScene) {
    throw new Error(`Elemen per scene maksimal ${PROJECT_LIMITS.maxElementsPerScene}`);
  }

  const durationSec = scene?.durationSec === undefined ? 4 : scene.durationSec;
  if (typeof durationSec !== 'number'
    || !Number.isFinite(durationSec)
    || durationSec <= 0
    || durationSec > PROJECT_LIMITS.maxDurationSec) {
    throw new Error('Durasi scene tidak valid');
  }

  for (const element of elements) {
    if (element?.motion && element.motion.startSec + element.motion.durationSec > durationSec + 0.00001) {
      throw new Error('Animasi elemen melebihi durasi scene');
    }
  }
  return {
    id: normalizeId(scene?.id, SCENE_ID_PATTERN, 'scn'),
    durationSec,
    transition: normalizeTransition(scene?.transition),
    elements: elements.map((element) => normalizeElement(element, textBudget)),
  };
}

export function normalizeProjectDraft(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Project harus berupa objek');
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error('Versi skema project tidak didukung');
  }

  const template = assertString(input.template, 'Template tidak valid', PROJECT_LIMITS.maxTemplateChars);
  if (!TEMPLATE_ID_PATTERN.test(template)) throw new Error('Template tidak valid');

  const scenes = Array.isArray(input.scenes) ? input.scenes : [];
  if (scenes.length > PROJECT_LIMITS.maxScenes) {
    throw new Error(`Scene maksimal ${PROJECT_LIMITS.maxScenes}`);
  }

  const title = input.title === undefined
    ? 'Untitled project'
    : assertString(input.title, 'Judul project tidak valid', PROJECT_LIMITS.maxTitleChars);

  const textBudget = { used: 0 };
  const normalizedScenes = scenes.map((scene) => normalizeScene(scene, textBudget));
  const totalSceneDuration = sumSceneDurations(normalizedScenes);
  if (totalSceneDuration > JOB_LIMITS.maxDuration) {
    throw new Error(`Total durasi scene melebihi batas ${JOB_LIMITS.maxDuration} detik`);
  }

  const normalized = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: normalizeId(input.projectId, PROJECT_ID_PATTERN, 'prj'),
    title,
    template,
    render: normalizeRender(input.render),
    theme: normalizeTheme(input.theme),
    audio: normalizeAudio(input.audio),
    scenes: normalizedScenes,
  };
  normalized.render.duration = totalSceneDuration;

  validateJobLimits({
    duration: normalized.render.duration,
    fps: normalized.render.fps,
    width: normalized.render.width,
    height: normalized.render.height,
    codec: normalized.render.codec,
  });

  return normalized;
}

export function assertProjectForRender(project) {
  return normalizeProjectDraft(project);
}
