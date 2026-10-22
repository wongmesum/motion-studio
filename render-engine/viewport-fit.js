/*
 * Viewport-safe stage adapter.
 * Existing templates draw on a 1920×1080 logical stage. On other viewport
 * dimensions (including 1080×1920) fit the *entire* stage without cropping,
 * leaving a controlled, theme-colored background outside the stage.
 * Gesture overlays stay outside this wrapper and use the actual output size.
 * This is a compatibility layout, not a native portrait composition engine.
 */
(function () {
  'use strict';
  const dataNode = document.getElementById('motion-project-data');
  if (!dataNode) return;
  let project;
  try { project = JSON.parse(dataNode.textContent); } catch { return; }
  if (!project || !project.render || !document.body) return;

  const root = document.documentElement;
  const body = document.body;
  const stage = document.createElement('div');
  stage.id = 'motion-stage-fit';
  const css = document.createElement('style');
  css.id = 'motion-stage-fit-style';
  css.textContent = [
    'html,body{width:100vw!important;height:100vh!important;margin:0!important;overflow:hidden!important;}',
    'html{background:#080b17!important;}',
    'body{position:relative!important;background:radial-gradient(ellipse at 50% 45%,#17254a,#080b17 75%)!important;}',
    '#motion-stage-fit{position:absolute!important;left:0;top:0;width:1920px;height:1080px;',
    'transform-origin:0 0;overflow:hidden;pointer-events:none;}'
  ].join('');
  document.head.appendChild(css);

  const movable = Array.from(body.children).filter(node =>
    node.tagName !== 'SCRIPT' && node.id !== 'motion-stage-fit');
  body.insertBefore(stage, body.firstChild);
  for (const node of movable) stage.appendChild(node);
  function fit() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (!width || !height) return;
    const scale = Math.min(width / 1920, height / 1080);
    const x = (width - 1920 * scale) / 2;
    const y = (height - 1080 * scale) / 2;
    stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
  }
  window.addEventListener('resize', fit);
  fit();
  window.__MOTION_VIEWPORT_FIT__ = { stage };
})();
