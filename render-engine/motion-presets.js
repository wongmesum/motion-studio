/*
 * Shared deterministic motion evaluator. Injected inline by compileProject,
 * before authored templates execute; no CDN, timing loop or dynamic code.
 * Each preset is a pure function of scene-local seconds.
 */
(function () {
  'use strict';
  const IDENTITY = Object.freeze({ opacity: 1, offsetX: 0, offsetY: 0, scale: 1 });
  const PRESETS = Object.freeze(['none', 'fade-in', 'slide-up', 'slide-left', 'zoom-in']);
  function linearFrameMotion(keyframes, elapsed) {
    if (!Array.isArray(keyframes) || keyframes.length < 2) return IDENTITY;
    let a = keyframes[0];
    let b = keyframes[keyframes.length - 1];
    if (elapsed <= a.timeSec) b = a;
    else if (elapsed >= b.timeSec) a = b;
    else for (let i = 0; i < keyframes.length - 1; i++) {
      if (elapsed <= keyframes[i + 1].timeSec) {
        a = keyframes[i];
        b = keyframes[i + 1];
        break;
      }
    }
    const delta = b.timeSec - a.timeSec;
    const p = delta > 0 ? Math.max(0, Math.min(1, (elapsed - a.timeSec) / delta)) : 0;
    const mix = (field, fallback) =>
      (a[field] === undefined ? fallback : a[field]) +
      ((b[field] === undefined ? fallback : b[field]) -
      (a[field] === undefined ? fallback : a[field])) * p;
    return {
      opacity: mix('opacity', 1), offsetX: mix('x', 0),
      offsetY: mix('y', 0), scale: mix('scale', 1)
    };
  }
  function evaluate(motion, seconds) {
    if (!motion || !Number.isFinite(seconds)) return IDENTITY;
    const start = Number(motion.startSec);
    const duration = Number(motion.durationSec);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return IDENTITY;
    if (Array.isArray(motion.keyframes) && motion.keyframes.length >= 2) {
      // Keyframes replace the entry preset. All times are relative to startSec.
      return linearFrameMotion(motion.keyframes, seconds - start);
    }
    if (motion.preset === 'none' || !PRESETS.includes(motion.preset)) return IDENTITY;
    const raw = Math.max(0, Math.min(1, (seconds - start) / duration));
    const p = 1 - Math.pow(1 - raw, 3);
    return {
      opacity: p,
      offsetX: motion.preset === 'slide-left' ? (1 - p) * 80 : 0,
      offsetY: motion.preset === 'slide-up' ? (1 - p) * 60 : 0,
      scale: motion.preset === 'zoom-in' ? 0.85 + p * 0.15 : 1
    };
  }
  window.MotionStudioMotion = Object.freeze({ evaluate, presets: PRESETS });
})();
