/**
 * Lightweight SceneDirector-inspired path editor for Motion Studio.
 * Renders draggable start/end markers above the sandboxed preview iframe.
 * The overlay is editor-only; export uses normalized scene.gestures data.
 */
export function createGesturePathEditor({ document: doc, store, getSelection }) {
  const stage = doc.getElementById('previewStage');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.id = 'gesturePathEditor';
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-label', 'Editor visual jalur gesture');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:4;pointer-events:none;';
  stage.append(svg);
  let activeDrag = null;

  function updateGesture(sceneId, index, name, coords) {
    store.updateScene(sceneId, (scene) => ({
      gestures: (scene.gestures || []).map((gesture, i) => i !== index ? gesture : {
        ...gesture, [name]: coords
      }),
    }));
  }
  function point(event) {
    const rect = stage.getBoundingClientRect();
    const clamp = value => Math.max(0, Math.min(1, value));
    return {
      x: Math.round(clamp((event.clientX - rect.left) / rect.width) * 1000) / 1000,
      y: Math.round(clamp((event.clientY - rect.top) / rect.height) * 1000) / 1000,
    };
  }
  function marker(name, coords, gesture, sceneId, index, group) {
    const circle = doc.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(coords.x * 1000));
    circle.setAttribute('cy', String(coords.y * 1000));
    circle.setAttribute('r', '15');
    circle.setAttribute('fill', name === 'from' ? '#38bdf8' : '#a855f7');
    circle.setAttribute('stroke', 'white');
    circle.setAttribute('stroke-width', '4');
    circle.setAttribute('aria-label', 'Gesture ' + (index + 1) + ' ' + name);
    circle.style.cssText = 'pointer-events:all;cursor:grab;touch-action:none;';
    circle.addEventListener('pointerdown', event => {
      activeDrag = { sceneId, index, name, gesture, pointerId: event.pointerId };
      circle.setPointerCapture(event.pointerId);
      circle.style.cursor = 'grabbing';
    });
    circle.addEventListener('pointermove', event => {
      if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
      const next = point(event);
      circle.setAttribute('cx', String(next.x * 1000));
      circle.setAttribute('cy', String(next.y * 1000));
      const line = group.querySelector('line');
      line.setAttribute(name === 'from' ? 'x1' : 'x2', String(next.x * 1000));
      line.setAttribute(name === 'from' ? 'y1' : 'y2', String(next.y * 1000));
    });
    function finish(event) {
      if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
      const next = point(event);
      const { sceneId: currentScene, index: currentIndex, name: pointName } = activeDrag;
      activeDrag = null;
      circle.style.cursor = 'grab';
      updateGesture(currentScene, currentIndex, pointName, next);
    }
    circle.addEventListener('pointerup', finish);
    circle.addEventListener('pointercancel', () => { activeDrag = null; render(); });
    return circle;
  }
  function render() {
    if (activeDrag) return;
    svg.replaceChildren();
    const project = store.getProject();
    const selection = getSelection();
    const scene = project.scenes.find(item => item.id === selection?.sceneId);
    if (!scene) return;
    (scene.gestures || []).forEach((gesture, index) => {
      const group = doc.createElementNS(ns, 'g');
      const line = doc.createElementNS(ns, 'line');
      line.setAttribute('x1', String(gesture.from.x * 1000));
      line.setAttribute('y1', String(gesture.from.y * 1000));
      line.setAttribute('x2', String(gesture.to.x * 1000));
      line.setAttribute('y2', String(gesture.to.y * 1000));
      line.setAttribute('stroke', 'white');
      line.setAttribute('stroke-width', '3');
      line.setAttribute('stroke-dasharray', '10 7');
      line.setAttribute('opacity', '0.7');
      group.append(line);
      // SVG paints later children last. Tap's coincident markers are both draggable
      // via the inspector numeric controls; visually the end marker is on top.
      group.append(marker('from', gesture.from, gesture, scene.id, index, group));
      group.append(marker('to', gesture.to, gesture, scene.id, index, group));
      svg.append(group);
    });
  }
  return { render };
}
