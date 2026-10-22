import { supportsProperty } from './template-capabilities.js';

const ASSET_ID_PATTERN = /^ast_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES = ['title', 'subtitle', 'caption', 'background', 'pip', 'logo'];
const ALIGNMENTS = ['left', 'center', 'right'];
const FITS = ['cover', 'contain'];
const TRANSITIONS = ['fade', 'slide', 'none'];
const MOTION_PRESETS = ['none', 'fade-in', 'slide-up', 'slide-left', 'zoom-in'];

function control(doc, labelText, input) {
  const label = doc.createElement('label');
  label.textContent = labelText;
  label.append(input);
  return label;
}

function input(doc, type, value, attributes = {}) {
  const element = doc.createElement('input');
  element.type = type;
  element.value = value;
  for (const [name, attributeValue] of Object.entries(attributes)) {
    if (attributeValue === true) element.setAttribute(name, '');
    else element.setAttribute(name, attributeValue);
  }
  return element;
}

function kindForAsset(asset) {
  if (asset?.mime?.startsWith('image/')) return 'image';
  if (asset?.mime?.startsWith('video/')) return 'video';
  return 'audio';
}

function select(doc, value, values) {
  const element = doc.createElement('select');
  element.replaceChildren(...values.map((optionValue) => {
    const option = doc.createElement('option');
    option.value = optionValue;
    option.textContent = optionValue;
    option.selected = optionValue === value;
    return option;
  }));
  return element;
}

/** Inspector for the selected scene and element. Writes through the immutable store. */
export function createInspector({ document: doc, store, assetsPanel, notify }) {
  const form = doc.getElementById('inspectorForm');
  const empty = doc.getElementById('inspectorEmpty');
  let selection = { sceneId: null, elementId: null };

  function selectedPair(project) {
    const scene = project.scenes.find((item) => item.id === selection.sceneId);
    const element = scene?.elements.find((item) => item.id === selection.elementId) || null;
    return { scene, element };
  }

  function textFields(group, scene, element) {
    const text = input(doc, 'text', element.text, { maxlength: '500' });
    text.addEventListener('input', () => {
      store.updateElement(scene.id, element.id, () => ({ text: text.value }));
    });
    group.append(control(doc, 'Teks', text));

    const role = select(doc, element.role, ROLES);
    role.addEventListener('change', () => {
      store.updateElement(scene.id, element.id, () => ({ role: role.value }));
    });
    group.append(control(doc, 'Role', role));

    const fontSize = input(doc, 'number', element.fontSize, { min: '12', max: '240' });
    fontSize.addEventListener('change', () => {
      const value = Math.round(Number(fontSize.value));
      if (Number.isFinite(value)) {
        store.updateElement(scene.id, element.id, () => ({ fontSize: value }));
      }
    });
    group.append(control(doc, 'Ukuran font', fontSize));

    const color = input(doc, 'color', element.color);
    color.addEventListener('input', () => {
      store.updateElement(scene.id, element.id, () => ({ color: color.value }));
    });
    group.append(control(doc, 'Warna', color));

    const align = select(doc, element.align, ALIGNMENTS);
    align.addEventListener('change', () => {
      store.updateElement(scene.id, element.id, () => ({ align: align.value }));
    });
    group.append(control(doc, 'Perataan', align));
  }

  function visualFields(group, scene, element, templateId) {
    // The picker only offers media the element can actually render: an image element must
    // never surface a video asset, and vice versa. Audio never belongs in a visual picker.
    const library = assetsPanel
      .getAssets()
      .filter((asset) => kindForAsset(asset) === element.type);
    const supports = (property) => supportsProperty(templateId, element.type, property);
    const assetSelect = doc.createElement('select');
    assetSelect.id = 'elementAssetSelect';
    assetSelect.replaceChildren(
      ...[{ assetId: '', originalName: '— pilih aset —' }, ...library].map((asset) => {
        const option = doc.createElement('option');
        option.value = asset.assetId;
        option.textContent = asset.originalName || asset.assetId;
        option.selected = asset.assetId === element.assetId;
        return option;
      })
    );
    assetSelect.addEventListener('change', () => {
      if (!assetSelect.value) return;
      store.updateElement(scene.id, element.id, () => ({ assetId: assetSelect.value }));
    });
    group.append(control(doc, 'Aset', assetSelect));

    if (supports('fit')) {
      const fit = select(doc, element.fit, FITS);
      fit.addEventListener('change', () => {
        store.updateElement(scene.id, element.id, () => ({ fit: fit.value }));
      });
      group.append(control(doc, 'Fit', fit));
    }

    if (element.type === 'image' && supports('kenBurns')) {
      const kenBurns = input(doc, 'checkbox', '', {});
      kenBurns.checked = Boolean(element.kenBurns);
      kenBurns.addEventListener('change', () => {
        store.updateElement(scene.id, element.id, () => ({ kenBurns: kenBurns.checked }));
      });
      group.append(control(doc, 'Ken Burns', kenBurns));
    }

    if (supports('position')) {
      for (const [field, labelText] of [['x', 'Posisi X'], ['y', 'Posisi Y'], ['width', 'Lebar']]) {
        const fieldInput = input(doc, 'number', element[field], { min: '0', max: '1', step: '0.01' });
        fieldInput.addEventListener('change', () => {
          const value = Number(fieldInput.value);
          if (Number.isFinite(value) && value >= 0 && value <= 1) {
            store.updateElement(scene.id, element.id, () => ({ [field]: value }));
          }
        });
        group.append(control(doc, labelText, fieldInput));
      }
    }
  }

  /** Project-level audio: one track for the whole video, not a per-scene element. */
  function projectFields(group, project) {
    const audioAssets = assetsPanel
      .getAssets()
      .filter((asset) => kindForAsset(asset) === 'audio');
    const audioSelect = doc.createElement('select');
    audioSelect.id = 'projectAudioSelect';
    audioSelect.replaceChildren(
      ...[
        { assetId: '', originalName: '— tanpa audio —' },
        ...(project.audio?.assetId && !audioAssets.some((a) => a.assetId === project.audio.assetId)
          ? [{ assetId: project.audio.assetId, originalName: 'Audio terikat' }]
          : []),
        ...audioAssets,
      ].map((asset) => {
        const option = doc.createElement('option');
        option.value = asset.assetId;
        option.textContent = asset.originalName || asset.assetId;
        option.selected = asset.assetId === (project.audio?.assetId || '');
        return option;
      })
    );
    audioSelect.addEventListener('change', () => {
      const assetId = audioSelect.value;
      store.update(() => ({
        audio: assetId && ASSET_ID_PATTERN.test(assetId) ? { assetId } : null,
      }));
    });
    group.append(control(doc, 'Audio project', audioSelect));

    const hint = doc.createElement('p');
    hint.className = 'inspector-hint';
    hint.textContent = 'Audio disatukan saat render; preview tetap senyap.';
    group.append(hint);
  }

  // SceneDirector-style path controls: start/end coordinates are relative to the canvas.
  function gestureFields(group, scene) {
    const gestures = scene.gestures || [];
    const add = doc.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-ghost btn-sm';
    add.textContent = '+ Tambah gesture';
    add.disabled = gestures.length >= 6;
    add.addEventListener('click', () => {
      store.updateScene(scene.id, (current) => ({
        gestures: [...(current.gestures || []), {
          type: 'tap', effect: 'sunburst', startSec: 0,
          durationSec: Math.min(1, current.durationSec),
          from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 },
        }],
      }));
      render();
    });
    const heading = doc.createElement('h3');
    heading.textContent = 'Gesture / Lottie';
    group.append(heading, add);
    const updateGesture = (index, patch) => {
      store.updateScene(scene.id, (current) => ({
        gestures: (current.gestures || []).map((item, i) =>
          i === index ? { ...item, ...patch } : item
        ),
      }));
    };
    gestures.forEach((gesture, index) => {
      const heading = doc.createElement('h3');
      heading.textContent = 'Gesture ' + (index + 1);
      group.append(heading);
      for (const [key, labelText, choices] of [
        ['type', 'Aksi', ['tap', 'swipe']],
        ['effect', 'Efek Lottie', ['none', 'sunburst', 'sunburst-soft', 'sunburst-wide', 'sunburst-star']],
      ]) {
        const widget = select(doc, gesture[key], choices);
        widget.addEventListener('change', () => updateGesture(index, {
          [key]: widget.value,
          ...(key === 'type' && widget.value === 'tap' ? { keyframes: undefined } : {})
        }));
        group.append(control(doc, labelText, widget));
      }
      for (const [key, labelText] of [['startSec', 'Mulai (detik)'], ['durationSec', 'Durasi (detik)']]) {
        const widget = input(doc, 'number', gesture[key], { min: key === 'startSec' ? '0' : '0.1', max: String(scene.durationSec), step: '0.1' });
        widget.addEventListener('change', () => {
          const n = Number(widget.value);
          const start = key === 'startSec' ? n : gesture.startSec;
          const duration = key === 'durationSec' ? n : gesture.durationSec;
          if (Number.isFinite(n) && start >= 0 && duration > 0
            && start + duration <= scene.durationSec + 0.00001) {
            updateGesture(index, { [key]: n });
          } else notify('Gesture harus berada dalam durasi scene.', 'error');
        });
        group.append(control(doc, labelText, widget));
      }
      for (const [point, name] of [['from', 'Mulai'], ['to', 'Tujuan']]) {
        for (const axis of ['x', 'y']) {
          const field = input(doc, 'number', gesture[point][axis], { min: '0', max: '1', step: '0.01' });
          field.addEventListener('change', () => {
            const n = Number(field.value);
            if (Number.isFinite(n) && n >= 0 && n <= 1) {
              updateGesture(index, { [point]: { ...gesture[point], [axis]: n } });
            } else notify('Koordinat gesture harus 0 sampai 1.', 'error');
          });
          group.append(control(doc, name + ' ' + axis.toUpperCase(), field));
        }
      }
      if (gesture.type === 'swipe') {
        const easing = select(doc, gesture.easing || 'ease-out',
          ['linear', 'ease-in', 'ease-out', 'ease-in-out']);
        easing.addEventListener('change', () =>
          updateGesture(index, { easing: easing.value }));
        group.append(control(doc, 'Easing lintasan', easing));

        const keyframes = gesture.keyframes || [];
        const addKeyframe = doc.createElement('button');
        addKeyframe.type = 'button';
        addKeyframe.className = 'btn btn-ghost btn-sm';
        addKeyframe.textContent = '+ Tambah keyframe';
        addKeyframe.disabled = keyframes.length >= 4;
        addKeyframe.addEventListener('click', () => {
          const stops = [
            { at: 0, x: gesture.from.x, y: gesture.from.y },
            ...keyframes,
            { at: 1, x: gesture.to.x, y: gesture.to.y }
          ];
          let widest = 0;
          for (let i = 1; i < stops.length; i++) {
            if (stops[i].at - stops[i - 1].at > stops[widest + 1].at - stops[widest].at) {
              widest = i - 1;
            }
          }
          const before = stops[widest], after = stops[widest + 1];
          const frame = {
            at: Math.round((before.at + after.at) * 500) / 1000,
            x: Math.round((before.x + after.x) * 500) / 1000,
            y: Math.round((before.y + after.y) * 500) / 1000
          };
          updateGesture(index, { keyframes: [...keyframes, frame].sort((a, b) => a.at - b.at) });
          render();
        });
        group.append(addKeyframe);
        keyframes.forEach((frame, frameIndex) => {
          const label = doc.createElement('p');
          label.className = 'inspector-hint';
          label.textContent = 'Keyframe ' + (frameIndex + 1) + ' (posisi relatif waktu)';
          group.append(label);
          for (const [axis, caption] of [['at', 'Waktu 0–1'], ['x', 'X'], ['y', 'Y']]) {
            const field = input(doc, 'number', frame[axis], { min: '0', max: '1', step: '0.01' });
            field.addEventListener('change', () => {
              const value = Number(field.value);
              const prev = frameIndex === 0 ? 0 : keyframes[frameIndex - 1].at;
              const next = frameIndex === keyframes.length - 1 ? 1 : keyframes[frameIndex + 1].at;
              const valid = Number.isFinite(value) && value >= 0 && value <= 1
                && (axis !== 'at' || (value > prev && value < next));
              if (!valid) {
                notify('Keyframe harus berada dalam batas dan urutan waktunya.', 'error');
                return;
              }
              const updated = keyframes.map((item, i) =>
                i === frameIndex ? { ...item, [axis]: value } : item);
              updateGesture(index, { keyframes: updated });
            });
            group.append(control(doc, caption, field));
          }
          const removeFrame = doc.createElement('button');
          removeFrame.type = 'button';
          removeFrame.className = 'btn btn-ghost btn-sm';
          removeFrame.textContent = 'Hapus keyframe ' + (frameIndex + 1);
          removeFrame.addEventListener('click', () => {
            updateGesture(index, { keyframes: keyframes.filter((_, i) => i !== frameIndex) });
            render();
          });
          group.append(removeFrame);
        });
      }
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-danger btn-sm';
      remove.textContent = 'Hapus gesture ' + (index + 1);
      remove.addEventListener('click', () => {
        store.updateScene(scene.id, (current) => ({
          gestures: (current.gestures || []).filter((_, i) => i !== index),
        }));
        render();
      });
      group.append(remove);
    });
  }

  function sceneFields(group, scene) {
    const duration = input(doc, 'number', scene.durationSec, { min: '1', max: '60', step: '0.5' });
    duration.addEventListener('change', () => {
      const value = Number(duration.value);
      const lastGesture = Math.max(0, ...(scene.gestures || []).map((g) => g.startSec + g.durationSec));
      if (Number.isFinite(value) && value > 0 && value >= lastGesture) {
        store.updateScene(scene.id, () => ({ durationSec: value }));
      }
    });
    group.append(control(doc, 'Durasi scene (detik)', duration));

    const transition = select(doc, scene.transition?.type || 'fade', TRANSITIONS);
    transition.addEventListener('change', () => {
      store.updateScene(scene.id, () => ({
        transition: { ...scene.transition, type: transition.value },
      }));
    });
    group.append(control(doc, 'Transisi', transition));
  }

  function render() {
    const project = store.getProject();
    const { scene, element } = selectedPair(project);
    const hasSelection = Boolean(scene);

    empty.hidden = hasSelection;
    form.hidden = !hasSelection;
    if (!hasSelection) {
      form.replaceChildren();
      return;
    }

    form.replaceChildren();
    const sceneGroup = doc.createElement('div');
    sceneGroup.className = 'inspector-group';
    const sceneHeading = doc.createElement('h3');
    sceneHeading.textContent = 'Scene';
    sceneGroup.append(sceneHeading);
    projectFields(sceneGroup, project);
    sceneFields(sceneGroup, scene);
    gestureFields(sceneGroup, scene);

    const addActions = doc.createElement('div');
    addActions.className = 'inspector-actions';
    const addTypes = [
      { type: 'text', label: '+ Teks' },
      { type: 'image', label: '+ Gambar' },
      { type: 'video', label: '+ Video' },
    ];
    for (const item of addTypes) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-sm';
      button.textContent = item.label;
      button.addEventListener('click', () => {
        const asset = item.type === 'text'
          ? null
          : assetsPanel.getAssets().find((candidate) => candidate.mime?.startsWith(`${item.type}/`));
        if (item.type !== 'text' && !asset) {
          notify(`Unggah aset ${item.type === 'image' ? 'gambar' : 'video'} terlebih dahulu.`, 'error');
          return;
        }
        const elementId = store.addElement(scene.id, item.type, asset?.assetId);
        selection = { sceneId: scene.id, elementId };
        render();
      });
      addActions.append(button);
    }
    sceneGroup.append(addActions);
    form.append(sceneGroup);

    if (!element) return;

    const elementGroup = doc.createElement('div');
    elementGroup.className = 'inspector-group';
    const elementHeading = doc.createElement('h3');
    elementHeading.textContent = `Elemen ${element.type}`;
    elementGroup.append(elementHeading);
    if (element.type === 'text') textFields(elementGroup, scene, element);
    else visualFields(elementGroup, scene, element, project.template);

    // Only show controls when a template has a corresponding playback path.
    // The mixer renders title text and PiP media, but not subtitle/caption text.
    const motionRenderable = supportsProperty(project.template, element.type, 'motion') &&
      (element.type !== 'text' || (
        project.template === 'video-mixer'
          ? element.role === 'title'
          : ['title', 'subtitle', 'caption'].includes(element.role)
      ));
    if (motionRenderable) {
      const motionHeading = doc.createElement('h3');
      motionHeading.textContent = 'Animasi elemen';
      elementGroup.append(motionHeading);
      const motion = element.motion || { preset: 'none', startSec: 0, durationSec: Math.min(0.8, scene.durationSec) };
      const preset = select(doc, motion.preset, MOTION_PRESETS);
      preset.addEventListener('change', () => {
        store.updateElement(scene.id, element.id, () => ({ motion: preset.value === 'none' && !motion.keyframes ? undefined : { ...motion, preset: preset.value } }));
      });
      elementGroup.append(control(doc, 'Preset motion', preset));
      for (const [field, labelText] of [['startSec', 'Mulai (detik)'], ['durationSec', 'Durasi (detik)']]) {
        const value = input(doc, 'number', motion[field], { min: field === 'startSec' ? '0' : '0.1', max: String(scene.durationSec), step: '0.1' });
        value.addEventListener('change', () => {
          const seconds = Number(value.value);
          if (Number.isFinite(seconds) && seconds >= (field === 'startSec' ? 0 : 0.1)
            && (field === 'startSec' ? seconds + motion.durationSec <= scene.durationSec : motion.startSec + seconds <= scene.durationSec && (!motion.keyframes || motion.keyframes[motion.keyframes.length - 1].timeSec <= seconds))) {
            store.updateElement(scene.id, element.id, () => ({ motion: { ...motion, [field]: seconds } }));
          } else notify('Timing animasi harus berada dalam durasi scene.', 'error');
        });
        elementGroup.append(control(doc, labelText, value));
      }

      const frames = motion.keyframes || [];
      const subheading = doc.createElement('h4');
      subheading.textContent = 'Jalur gerak / Keyframe';
      elementGroup.append(subheading);
      const updateMotion = patch => store.updateElement(scene.id, element.id, () => ({
        motion: patch
      }));
      const action = (label, handler) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-ghost btn-sm';
        button.textContent = label;
        button.addEventListener('click', handler);
        elementGroup.append(button);
      };
      if (!frames.length) {
        action('+ Buat motion path', () => updateMotion({
          ...motion, preset: 'none', keyframes: [
            { timeSec: 0, x: 0, y: 60, scale: 0.9, opacity: 0 },
            { timeSec: motion.durationSec, x: 0, y: 0, scale: 1, opacity: 1 }
          ]
        }));
      } else {
        action('Hapus motion path', () => updateMotion(
          motion.preset === 'none' ? undefined : {
            preset: motion.preset, startSec: motion.startSec, durationSec: motion.durationSec
          }
        ));
        const limits = {
          timeSec: [0, motion.durationSec], x: [-600, 600], y: [-600, 600],
          scale: [0.1, 3], opacity: [0, 1]
        };
        const commitFrames = next => updateMotion({ ...motion, keyframes: next });
        for (const [index, frame] of frames.entries()) {
          const group = doc.createElement('fieldset');
          group.className = 'inspector-group';
          const legend = doc.createElement('legend');
          legend.textContent = 'Keyframe ' + (index + 1);
          group.append(legend);
          for (const [name, label] of [
            ['timeSec', 'Waktu (detik)'], ['x', 'X (px)'], ['y', 'Y (px)'],
            ['scale', 'Skala'], ['opacity', 'Opacity']
          ]) {
            const [min, max] = limits[name];
            const widget = input(doc, 'number', frame[name],
              { min: String(min), max: String(max), step: 'any' });
            widget.addEventListener('change', () => {
              const v = Number(widget.value);
              const prev = index ? frames[index - 1].timeSec : -1;
              const next = index < frames.length - 1
                ? frames[index + 1].timeSec : Infinity;
              if (!Number.isFinite(v) || v < min || v > max ||
                (name === 'timeSec' && (v <= prev || v >= next))) {
                widget.value = frame[name];
                notify('Keyframe tidak valid atau waktunya tidak berurutan.', 'error');
                return;
              }
              commitFrames(frames.map((item, i) => i === index
                ? { ...item, [name]: v } : item));
            });
            group.append(control(doc, label, widget));
          }
          if (frames.length > 2) {
            const remove = doc.createElement('button');
            remove.type = 'button';
            remove.className = 'btn btn-ghost btn-sm';
            remove.textContent = 'Hapus titik ' + (index + 1);
            remove.addEventListener('click', () =>
              commitFrames(frames.filter((_, i) => i !== index)));
            group.append(remove);
          }
          elementGroup.append(group);
        }
        if (frames.length < 8) action('+ Tambah keyframe', () => {
          const end = frames[frames.length - 1];
          const before = frames[frames.length - 2];
          if (end.timeSec - before.timeSec <= 0.02) {
            notify('Jarak keyframe terlalu rapat.', 'error');
            return;
          }
          const avg = (field) => (before[field] + end[field]) / 2;
          commitFrames([
            ...frames.slice(0, -1),
            { timeSec: avg('timeSec'), x: avg('x'), y: avg('y'),
              scale: avg('scale'), opacity: avg('opacity') },
            end
          ]);
        });
      }
  
    }

    const actions = doc.createElement('div');
    actions.className = 'inspector-actions';
    const deleteButton = doc.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-danger btn-sm';
    deleteButton.textContent = 'Hapus elemen';
    deleteButton.addEventListener('click', () => {
      store.removeElement(scene.id, element.id);
      selection = { sceneId: scene.id, elementId: null };
      notify('Elemen dihapus.', 'success');
    });
    actions.append(deleteButton);
    elementGroup.append(actions);
    form.append(elementGroup);
  }

  function bindAsset(sceneId, assetId) {
    const scene = store.getProject().scenes.find((item) => item.id === sceneId);
    const asset = assetsPanel.getAsset(assetId);
    if (!scene || !asset) return null;

    const type = kindForAsset(asset);
    if (type === 'audio') {
      // Audio is a single project-level track, muxed by FFmpeg after capture; it never
      // becomes a scene element, so the scene DOM and preview stay unchanged.
      store.update((current) => ({ ...current, audio: { assetId } }));
      notify('Audio diikat ke project. Preview tetap senyap; audio masuk saat render.', 'success');
      return { sceneId: scene.id, elementId: selection.elementId, audio: true };
    }

    const selected = scene.elements.find((element) => element.id === selection.elementId);
    if (selected?.type === type) {
      store.updateElement(scene.id, selected.id, () => ({ assetId }));
      selection = { sceneId: scene.id, elementId: selected.id };
      return { sceneId: scene.id, elementId: selected.id };
    }

    const matching = scene.elements.find((element) => element.type === type);
    if (matching) {
      store.updateElement(scene.id, matching.id, () => ({ assetId }));
      selection = { sceneId: scene.id, elementId: matching.id };
      return { sceneId: scene.id, elementId: matching.id };
    }

    const elementId = store.addElement(scene.id, type, assetId);
    selection = { sceneId: scene.id, elementId };
    return { sceneId: scene.id, elementId };
  }

  return {
    render,
    select(nextSelection) {
      selection = nextSelection;
      render();
    },
    bindAsset,
    getSelection() {
      return selection;
    },
  };
}
