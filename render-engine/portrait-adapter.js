/*
 * 9:16 compatibility adapter for authored 1920x1080 HTML templates.
 * All scene artwork is center-fitted (never cropped or distorted), with
 * complementary gradient sidebars. This is a first safe portrait layout,
 * not a portrait-native reflow of the individual Canvas compositions.
 * Inject after template scripts and BEFORE gesture-overlay runtime.
 */
(function () {
  'use strict';
  const projectNode = document.getElementById('motion-project-data');
  if (!projectNode) return;
  const project = JSON.parse(projectNode.textContent);
  const viewportWidth = project.render.width;
  const viewportHeight = project.render.height;
  if (viewportWidth >= viewportHeight) return;
  const designWidth = 1920, designHeight = 1080;
  const scale = Math.min(viewportWidth / designWidth, viewportHeight / designHeight);
  const scaledWidth = designWidth * scale;
  const scaledHeight = designHeight * scale;

  // The main composition is authored at 1920x1080. Reparenting its visible
  // elements preserves its local CSS positions, existing renderFrame refs,
  // and deterministic Canvas operations.
  const composition = document.createElement('div');
  composition.id = 'motion-scene-stage';
  composition.style.cssText = [
    'position:absolute', 'width:1920px', 'height:1080px',
    'transform-origin:top left', 'overflow:hidden', 'pointer-events:none',
    'left:' + ((viewportWidth - scaledWidth) / 2) + 'px',
    'top:' + ((viewportHeight - scaledHeight) / 2) + 'px',
    'transform:scale(' + scale + ')'
  ].join(';');
  const children = Array.from(document.body.children).filter(child =>
    !['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName) &&
    child.id !== 'motion-scene-stage' && child.id !== 'motion-gesture-layer');
  document.body.append(composition);
  children.forEach(child => composition.append(child));

  document.documentElement.style.setProperty('width', viewportWidth + 'px', 'important');
  document.documentElement.style.setProperty('height', viewportHeight + 'px', 'important');
  document.body.style.setProperty('width', viewportWidth + 'px', 'important');
  document.body.style.setProperty('height', viewportHeight + 'px', 'important');
  document.body.style.setProperty('margin', '0', 'important');
  document.body.style.setProperty('overflow', 'hidden', 'important');
  document.body.style.setProperty('background',
    'radial-gradient(ellipse at 50% 50%, #17234a, #080d20 66%, #03050e)', 'important');
  window.__MOTION_PORTRAIT_LAYOUT__ = Object.freeze({
    width: viewportWidth, height: viewportHeight, scale, designWidth, designHeight,
    contentWidth: scaledWidth, contentHeight: scaledHeight
  });
})();
