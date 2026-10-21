# Gesture + Lottie compatibility layer (phase 1)

Motion Studio remains an AI-first Playwright/FFmpeg generator. The initial
SceneDirector-inspired integration adds **scene gesture waypoints** rather than
mounting the source project's React/Remotion application.

## Supported project JSON

Add at most 6 `gestures` to a scene. Times are local to that scene and the
duration must fit inside the scene. All canvas coordinates are relative 0–1.

```json
{
  "durationSec": 3,
  "gestures": [{
    "type": "swipe",
    "effect": "sunburst",
    "startSec": 0.5,
    "durationSec": 1,
    "from": {"x": 0.25, "y": 0.4},
    "to": {"x": 0.75, "y": 0.4}
  }],
  "elements": []
}
```

The visual inspector lets you add/remove gestures and choose `tap` or
`swipe`, Lottie effect, start time, duration and coordinates. Draggable
waypoints in the preview are authoring handles only; they are never burned
into the export. The normalized data controls both preview and render output.

## Renderer and source attribution

The artwork was copied from:
https://github.com/ytrofr/claude-remotion-editor

Bundled Lottie JSON:
- `render-engine/lottie/cursor-real-black.json`
- `render-engine/lottie/click-sunburst-soft-4-sm.json`

The original repository's MIT license is preserved at
`third-party/claude-remotion-editor/LICENSE`.

`render-engine/gesture-overlay.js` implements a **limited local Lottie
shape-path renderer** for only these two known assets. It uses their vector
geometry and a deterministic timestamp to draw a cursor and burst.
This is **not** a complete Lottie player: arbitrary uploaded Lottie JSON,
text/image/3D layers, expressions, advanced masks, and original Lottie
interpolation curves are not supported. Do not present the two assets as the
entire 92-animation collection.

No external scripts, asset URLs, React/Remotion workers, or runtime network
calls are used for gesture rendering. The compiler injects vetted local vector
JSON and its runtime into sandboxed preview HTML and render HTML.

## Test and rollout gates

`npm test` includes gesture validation, visual consistency, and browser UI
waypoint drag tests. GitHub Actions also renders an 8-frame 1080p H.264 MP4 and
checks the output with FFprobe.

This is a first integration increment in a Draft PR. Before enabling the
rest of SceneDirector or additional Lottie files, explicitly review license
provenance for every new asset and add a supported renderer/test for its
animation features. Production VPS deployment is a separate gate.
