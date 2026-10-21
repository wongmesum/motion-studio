/**
 * SceneDirector-style visual path editor, independent from the sandboxed iframe.
 * Uses HTML buttons, not transformed SVG coordinates, for reliable pointer hit-tests
 * on Chromium, desktop and mobile touchscreens.
 */
export function createGesturePathEditor({ document: doc, store, getSelection }) {
  const stage = doc.getElementById('previewStage');
  const layer = doc.createElement('div');
  layer.id = 'gesturePathEditor';
  layer.setAttribute('aria-label', 'Editor visual jalur gesture');
  layer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:4;pointer-events:auto;';
  stage.append(layer);
  let activeDrag = false;
  const clamp = n => Math.max(0, Math.min(1, n));

  function point(event) {
    const rect = layer.getBoundingClientRect();
    return {
      x: Math.round(clamp((event.clientX - rect.left) / rect.width) * 1000) / 1000,
      y: Math.round(clamp((event.clientY - rect.top) / rect.height) * 1000) / 1000,
    };
  }
  function updateGesture(sceneId, index, name, coords) {
    store.updateScene(sceneId, current => ({
      gestures: (current.gestures || []).map((g, i) =>
        i === index ? { ...g, [name]: coords } : g),
    }));
  }
  function drawLine(line, start, end) {
    const rect = layer.getBoundingClientRect();
    const dx = (end.x - start.x) * rect.width;
    const dy = (end.y - start.y) * rect.height;
    line.style.left = (start.x * 100) + '%';
    line.style.top = (start.y * 100) + '%';
    line.style.width = Math.hypot(dx, dy) + 'px';
    line.style.transform = 'translateY(-50%) rotate(' + Math.atan2(dy, dx) + 'rad)';
  }
  function marker(gesture, pointName, index, sceneId, line, group) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = 'gesture-handle';
    node.setAttribute('aria-label', 'Gesture ' + (index + 1) + ' ' + pointName);
    node.style.cssText = [
      'position:absolute', 'width:26px', 'height:26px', 'border-radius:50%',
      'border:3px solid white', 'transform:translate(-50%,-50%)',
      'z-index:1', 'pointer-events:auto', 'touch-action:none', 'cursor:grab',
      'background:' + (pointName === 'from' ? '#38bdf8' : '#a855f7')
    ].join(';');
    const place = coords => {
      node.style.left = (coords.x * 100) + '%';
      node.style.top = (coords.y * 100) + '%';
    };
    place(gesture[pointName]);
    let dragged = null;
    node.addEventListener('pointerdown', event => {
      activeDrag = true;
      dragged = { pointerId: event.pointerId, location: gesture[pointName] };
      node.setPointerCapture(event.pointerId);
      node.style.cursor = 'grabbing';
      event.preventDefault();
    });
    node.addEventListener('pointermove', event => {
      if (!dragged || event.pointerId !== dragged.pointerId) return;
      dragged.location = point(event);
      place(dragged.location);
      const start = pointName === 'from' ? dragged.location : gesture.from;
      const end = pointName === 'to' ? dragged.location : gesture.to;
      drawLine(line, start, end);
    });
    node.addEventListener('pointerup', event => {
      if (!dragged || event.pointerId !== dragged.pointerId) return;
      const next = point(event);
      dragged = null;
      activeDrag = false;
      node.style.cursor = 'grab';
      updateGesture(sceneId, index, pointName, next);
    });
    node.addEventListener('pointercancel', () => {
      dragged = null;
      activeDrag = false;
      render();
    });
    return node;
  }
  function render() {
    if (activeDrag) return;
    layer.replaceChildren();
    const selection = getSelection();
    const scene = store.getProject().scenes.find(item => item.id === selection?.sceneId);
    if (!scene) return;
    (scene.gestures || []).forEach((gesture, index) => {
      const group = doc.createElement('div');
      group.className = 'gesture-path';
      group.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      const line = doc.createElement('div');
      line.style.cssText = 'position:absolute;height:2px;border-top:2px dashed white;opacity:.75;transform-origin:left center;pointer-events:none;';
      drawLine(line, gesture.from, gesture.to);
      group.append(line);
      group.append(marker(gesture, 'from', index, scene.id, line, group));
      group.append(marker(gesture, 'to', index, scene.id, line, group));
      layer.append(group);
    });
  }
  return { render };
}
