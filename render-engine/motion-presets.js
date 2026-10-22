/*
 * Shared deterministic motion evaluator. Injected inline by compileProject,
 * before authored templates execute; no CDN, timing loop or dynamic code.
 * Each preset is a pure function of scene-local seconds.
 */
(function () {
  'use strict';
  const IDENTITY = Object.freeze({ opacity: 1, offsetX: 0, offsetY: 0, scale: 1 });
  const PRESETS = Object.freeze(['none', 'fade-in', 'slide-up', 'slide-left', 'zoom-in']);
  function evaluate(motion, seconds) {
    if (!motion || motion.preset === 'none' || !PRESETS.includes(motion.preset)) return IDENTITY;
    const duration = Number(motion.durationSec);
    const start = Number(motion.startSec);
    if (!Number.isFinite(seconds) || !Number.isFinite(start) ||
      !Number.isFinite(duration) || duration <= 0) return IDENTITY;
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
