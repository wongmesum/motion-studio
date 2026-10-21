/*
 * SceneDirector-derived, deterministic gesture overlay for Motion Studio.
 * Two local Lottie artwork files provide the cursor vector and four-ray burst.
 * This intentionally supports ONLY the bundled shape-path subset, not arbitrary
 * external Lottie JSON or a complete lottie-web interpreter.
 * No timers/network/CSS animation: every frame is a pure function of seconds.
 */
(function () {
  'use strict';
  const dataNode = document.getElementById('motion-project-data');
  const artNode = document.getElementById('motion-gesture-art');
  if (!dataNode || !artNode || typeof window.renderFrame !== 'function') return;
  const project = JSON.parse(dataNode.textContent);
  const art = JSON.parse(artNode.textContent);
  const scenes = project.scenes || [];
  if (!scenes.some(scene => scene.gestures && scene.gestures.length)) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'motion-gesture-layer';
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;pointer-events:none;z-index:1000;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const source = art.cursor.layers[0].shapes[0].it.find(item => item.ty === 'sh').ks.k;
  const rays = art.burst.layers.map(layer => {
    const group = layer.shapes.find(item => item.ty === 'gr');
    return group.it.find(item => item.ty === 'sh').ks.k.v;
  });

  function ease(t) {
    const x = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - x, 3);
  }
  function pointAlong(gesture, p) {
    const progress = gesture.type === 'tap' ? 1 : ease(p);
    return {
      x: (gesture.from.x + (gesture.to.x - gesture.from.x) * progress) * canvas.width,
      y: (gesture.from.y + (gesture.to.y - gesture.from.y) * progress) * canvas.height
    };
  }
  function drawCursor(pos, scale) {
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.scale(scale, scale);
    const v = source.v, inn = source.i, out = source.o;
    ctx.beginPath();
    ctx.moveTo(v[0][0], v[0][1]);
    for (let i = 0; i < v.length - 1; i++) {
      ctx.bezierCurveTo(
        v[i][0] + out[i][0], v[i][1] + out[i][1],
        v[i + 1][0] + inn[i + 1][0], v[i + 1][1] + inn[i + 1][1],
        v[i + 1][0], v[i + 1][1]
      );
    }
    if (source.c) {
      const last = v.length - 1;
      ctx.bezierCurveTo(
        v[last][0] + out[last][0], v[last][1] + out[last][1],
        v[0][0] + inn[0][0], v[0][1] + inn[0][1],
        v[0][0], v[0][1]
      );
      ctx.closePath();
    }
    // The original artwork is black: add a light outline for dark templates.
    ctx.fillStyle = '#0b101e';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  function drawBurst(pos, p) {
    if (p < 0 || p > 1) return;
    const phase = ease(Math.min(1, p * 2));
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.globalAlpha = Math.max(0, Math.min(1, p * 6, (1 - p) * 3));
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const points of rays) {
      const from = points[0], to = points[1];
      // Lottie path geometry is centred at (100,100).
      ctx.beginPath();
      ctx.moveTo(from[0] - 100, from[1] - 100);
      ctx.lineTo(from[0] - 100 + (to[0] - from[0]) * phase,
        from[1] - 100 + (to[1] - from[1]) * phase);
      ctx.stroke();
    }
    ctx.restore();
  }

  const originalFrame = window.renderFrame;
  function drawFrame(seconds) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let offset = 0;
    for (const scene of scenes) {
      const local = seconds - offset;
      for (const gesture of scene.gestures || []) {
        const p = (local - gesture.startSec) / gesture.durationSec;
        if (p < 0 || p > 1) continue;
        const location = pointAlong(gesture, p);
        const press = gesture.type === 'tap' && p > 0.55 && p < 0.8 ? 0.88 : 1;
        drawCursor(location, press * 1.25);
        if (gesture.effect === 'sunburst') {
          const burstPhase = gesture.type === 'tap' ? (p - 0.55) / 0.45 : (p - 0.75) / 0.25;
          drawBurst(pointAlong(gesture, 1), burstPhase);
        }
      }
      offset += Number(scene.durationSec) || 0;
    }
  }
  window.renderFrame = function (seconds) {
    originalFrame.call(window, seconds);
    drawFrame(seconds);
  };
  window.renderFrame(0);
})();
