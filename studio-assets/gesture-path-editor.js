/**
 * SceneDirector-inspired waypoint editor outside the sandboxed preview iframe.
 * Each editable swipe keyframe owns a time position (in the inspector) and a
 * draggable XY handle (here). Handles never appear in the exported video.
 */
export function createGesturePathEditor({ document: doc, store, getSelection }) {
  const stage = doc.getElementById('previewStage');
  const layer = doc.createElement('div');
  layer.id = 'gesturePathEditor';
  layer.setAttribute('aria-label', 'Editor visual jalur gesture');
  layer.style.cssText = 'position:fixed;z-index:100;pointer-events:none;';
  doc.body.append(layer);
  function syncBounds() {
    const bounds = stage.getBoundingClientRect();
    layer.style.left = bounds.left + 'px';
    layer.style.top = bounds.top + 'px';
    layer.style.width = bounds.width + 'px';
    layer.style.height = bounds.height + 'px';
  }
  doc.defaultView.addEventListener('resize', syncBounds);
  doc.defaultView.addEventListener('scroll', syncBounds, { passive: true });
  if (doc.defaultView.ResizeObserver) {
    new doc.defaultView.ResizeObserver(syncBounds).observe(stage);
  }
  syncBounds();
  const clamp = n => Math.max(0, Math.min(1, n));
  let activeDrag = false;

  function point(event) {
    const rect = layer.getBoundingClientRect();
    return {
      x: Math.round(clamp((event.clientX - rect.left) / (rect.width || 1)) * 1000) / 1000,
      y: Math.round(clamp((event.clientY - rect.top) / (rect.height || 1)) * 1000) / 1000,
    };
  }
  function updateGesture(sceneId, gestureIndex, pointName, keyframeIndex, coords) {
    store.updateScene(sceneId, current => ({
      gestures: (current.gestures || []).map((gesture, i) => {
        if (i !== gestureIndex) return gesture;
        if (pointName !== 'keyframe') return { ...gesture, [pointName]: coords };
        const keyframes = (gesture.keyframes || []).map((item, j) =>
          j === keyframeIndex ? { ...item, ...coords } : item);
        return { ...gesture, keyframes };
      }),
    }));
  }
  function position(node, coords) {
    node.style.left = coords.x * 100 + '%';
    node.style.top = coords.y * 100 + '%';
  }
  function drawLine(line, from, to) {
    const bounds = layer.getBoundingClientRect();
    const dx = (to.x - from.x) * bounds.width;
    const dy = (to.y - from.y) * bounds.height;
    line.style.left = from.x * 100 + '%';
    line.style.top = from.y * 100 + '%';
    line.style.width = Math.hypot(dx, dy) + 'px';
    line.style.transform = 'translateY(-50%) rotate(' + Math.atan2(dy, dx) + 'rad)';
  }
  function render() {
    if (activeDrag) return;
    syncBounds();
    layer.replaceChildren();
    const selection = getSelection();
    const scene = store.getProject().scenes.find(item => item.id === selection?.sceneId);
    if (!scene) return;
    (scene.gestures || []).forEach((gesture, index) => {
      const group = doc.createElement('div');
      group.className = 'gesture-path';
      group.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      const stations = [
        { name: 'from', value: { ...gesture.from }, keyframeIndex: -1 },
        ...(gesture.keyframes || []).map((frame, i) => ({
          name: 'keyframe', value: { x: frame.x, y: frame.y }, keyframeIndex: i
        })),
        { name: 'to', value: { ...gesture.to }, keyframeIndex: -1 }
      ];
      const lines = stations.slice(1).map(() => {
        const line = doc.createElement('div');
        line.style.cssText = 'position:absolute;height:2px;border-top:2px dashed white;opacity:.75;transform-origin:left center;pointer-events:none;';
        group.append(line);
        return line;
      });
      const redraw = () => lines.forEach((line, i) =>
        drawLine(line, stations[i].value, stations[i + 1].value));
      redraw();
      stations.forEach((station, stationIndex) => {
        const node = doc.createElement('button');
        node.type = 'button';
        node.className = 'gesture-handle';
        node.setAttribute('aria-label', 'Gesture ' + (index + 1) + ' ' +
          (station.name === 'keyframe' ? 'keyframe ' + (station.keyframeIndex + 1) : station.name));
        const color = station.name === 'from' ? '#38bdf8'
          : station.name === 'to' ? '#a855f7' : '#f59e0b';
        node.style.cssText = [
          'position:absolute', 'width:26px', 'height:26px', 'border-radius:50%',
          'border:3px solid white', 'transform:translate(-50%,-50%)',
          'z-index:1', 'pointer-events:auto', 'touch-action:none', 'cursor:grab',
          'background:' + color,
        ].join(';');
        position(node, station.value);
        let dragId = null;
        node.addEventListener('pointerdown', event => {
          if (dragId !== null) return;
          dragId = event.pointerId;
          activeDrag = true;
          node.setPointerCapture(dragId);
          node.style.cursor = 'grabbing';
          event.preventDefault();
        });
        node.addEventListener('pointermove', event => {
          if (event.pointerId !== dragId) return;
          station.value = point(event);
          position(node, station.value);
          redraw();
        });
        node.addEventListener('pointerup', event => {
          if (event.pointerId !== dragId) return;
          const updated = point(event);
          dragId = null;
          activeDrag = false;
          node.style.cursor = 'grab';
          updateGesture(scene.id, index, station.name, station.keyframeIndex, updated);
        });
        node.addEventListener('pointercancel', () => {
          dragId = null;
          activeDrag = false;
          render();
        });
        group.append(node);
      });
      layer.append(group);
    });
  }
  return { render };
}
