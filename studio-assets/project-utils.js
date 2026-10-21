/**
 * Client-side mirror of the server's duration derivation.
 *
 * `render.duration` is never authored by hand: the scene timeline owns the length, and
 * both the browser and `normalizeProjectDraft` compute it from the same sum so preview,
 * save and render cannot disagree.
 */

export const MAX_RENDER_DURATION_SEC = 60;

export function sumSceneDurations(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  return scenes.reduce(
    (total, scene) => total + (Number(scene?.durationSec) || 0),
    0
  );
}

export function formatDuration(seconds) {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}
