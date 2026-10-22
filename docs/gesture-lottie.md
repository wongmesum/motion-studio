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

Five Lottie JSON files are bundled. All five are byte-identical to the matching
`public/lottie/<filename>` files at upstream commit
[`9f3130c48453182416ffe7a279d57a41dd929ae8`](https://github.com/ytrofr/claude-remotion-editor/tree/9f3130c48453182416ffe7a279d57a41dd929ae8).
The Git blob hashes below pin the audited artwork, not renderer compatibility.

| Local file | Git blob SHA | Use |
| --- | --- | --- |
| `render-engine/lottie/cursor-real-black.json` | `2b98eb701d7f7f05e44105ffdcb537a3c588daa3` | Gesture renderer |
| `render-engine/lottie/click-sunburst-soft-4-sm.json` | `0b8a5f44b9fe047eb45c34c5cf974b9bdd26d95c` | Gesture renderer |
| `modules/lottie/assets/click-sunburst-soft-xs.json` | `4c76a9f49df95d771984b2372bb4aa43ebdaa686` | Gesture renderer (`sunburst-soft`) and catalog |
| `modules/lottie/assets/cursor-anim-filled-click.json` | `c81ffc8b98d3f74d2e53a9085bfeca522286f92f` | Catalog only |
| `modules/lottie/assets/cursor-anim-filled-idle.json` | `4075e071c67ff07c4d470c11d81dab15422d7689` | Catalog only |

The upstream MIT license (copyright 2026 ytrofr) is preserved verbatim at
`third-party/claude-remotion-editor/LICENSE` and `modules/lottie/UPSTREAM-LICENSE`.
Copies or substantial portions of the artwork must retain the copyright and
permission notice. The production image includes both license paths with their assets, and
compiled preview/render HTML containing artwork embeds the complete license in
`motion-gesture-license`, a nonvisual JSON data block. The source ZIP build
scripts include both license files. No visible watermark is required by MIT.
The repository license and matching bytes establish repository-level attribution;
they do not independently establish the original authorship of each artwork.

`render-engine/gesture-overlay.js` uses the geometry of only the three renderer
assets with **locally authored deterministic animation**. It reads the cursor's
static Bezier path and the bursts' four or eight two-point rays. Cursor fill/outline,
scale and press timing, ray styling, opacity and growth are local choices;
source layer/group transforms, keyframes, trim-path instructions and interpolation
curves are not interpreted. The two animated cursor catalog entries are not connected to this
overlay and must not be advertised as playable animations.

Waypoints locate the cursor tip. Tap uses `to`; swipe eases from `from` to `to`.
Press scaling stays anchored at the tip, and the burst follows that same point.
This is **not** a complete Lottie player: arbitrary uploaded Lottie JSON,
text/image/3D layers, expressions, and advanced masks are not supported.
Do not present this integration as support for the entire 92-animation collection.

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

## Motion presets across templates (phase 2)

Project schema v1 is retained. The allowlisted element `motion` object supports
`none`, `fade-in`, `slide-up`, `slide-left` and `zoom-in`, with
`startSec` and `durationSec` relative to the active scene. Each animation
must finish within its scene. A shared, deterministic browser-side evaluator
(`render-engine/motion-presets.js`) is embedded locally by the compiler when
needed. It is executed before template scripts in both preview and final render.

| Template | Supported elements | Playback method |
| --- | --- | --- |
| `base` | Text title, subtitle, caption | Existing DOM preset renderer |
| `kinetic-text` | Text title, subtitle, caption | DOM motion layered over the neon/glitch entrance |
| `image-slideshow` | Text title, subtitle or caption fallback | Canvas motion on lower-third text |
| `video-mixer` | Text title and image/video PiP cards | Canvas alpha, translation and scale |

The visual inspector exposes controls only for the supported template/element
combinations. Unsupported roles, or image media in slideshow, do not gain inert
motion controls. The existing scene-level gesture overlay remains independent
of templates, so tap/swipe and both burst effects work on all four templates.

**Not yet implemented:** general-purpose Lottie playback, the complete
React/Remotion SceneDirector UI, keyframed editable motion curves, and
production deployment/portrait video smoke tests. Each new Lottie asset
requires license provenance and an explicit supported-rendering test.


## Per-element keyframe motion (phase 3)

Element motion extends existing schema v1 with an optional keyframe path.
When present, keyframes supersede an entry preset. Coordinates are in logical
1920×1080-stage pixels (not direct output pixels); timestamps are relative to
`motion.startSec`. Interpolation between points is deterministic and linear.

```json
{
  "preset": "none",
  "startSec": 0.25,
  "durationSec": 1.5,
  "keyframes": [
    { "timeSec": 0, "x": -120, "y": 60, "scale": 0.8, "opacity": 0 },
    { "timeSec": 0.75, "x": 10, "y": 0, "scale": 1.1, "opacity": 1 },
    { "timeSec": 1.5, "x": 0, "y": 0, "scale": 1, "opacity": 1 }
  ]
}
```

The inspector can add/delete keyframes and edit timing, x/y translation,
scale, and opacity. Each motion path has 2–8 strictly increasing keyframes.
Bounds: x/y ±600 px, scale 0.1–3 and opacity 0–1. The whole motion must
fit in the parent scene. Old preset-only projects still load unchanged.

## Portrait-safe 9:16 compatibility (phase 3)

For output sizes such as **1080×1920** or **720×1280**, the compiler injects
`render-engine/viewport-fit.js`: it fits the **entire** existing 1920×1080
logical stage inside the portrait output, preserving text and media without
clipping or distortion. The remaining area is themed background. SceneDirector
gesture overlays remain outside the transformed stage and use output-viewport
coordinates.

This is **letterbox/contain mode**, **not** a portrait-native layout engine.
Future 9:16 templates should reflow typography, images, safe zones and scene
geometry specifically for mobile rather than merely scaling a landscape stage.

Browser tests cover output geometry, preview vs export, motion keyframe replay,
and editor export. CI also renders a short **1080×1920 H.264 MP4** inspected
with FFprobe. VPS/staging visual QA is still required before deployment.

## Phase 3 — Gesture path keyframes and playable vector bursts

The curated local library now contains two additional burst assets from the
same MIT-licensed upstream repository:
- `modules/lottie/assets/click-sunburst-soft.json` (`sunburst-wide`): 8 rays
- `modules/lottie/assets/click-sunburst.json` (`sunburst-star`): 12 rays

The renderer supports **four authored gesture burst selections**: `sunburst`,
`sunburst-soft`, `sunburst-wide`, and `sunburst-star`. Each is drawn from
allowlisted local vector path data. Playback uses the Motion Studio timeline
and deterministic trim/stroke logic, **not** a full interpretation of the
upstream Lottie easing, compositing, or layer transforms. Curated cursor assets
that are catalogued but not mapped to playback remain catalog-only.

Swipe gestures can optionally include an easing and 1–4 intermediate path
keyframes. Time is the normalized progress within the gesture's
`durationSec`, not global video seconds:

```json
{
  "type": "swipe",
  "effect": "sunburst-star",
  "startSec": 0.4,
  "durationSec": 1.2,
  "easing": "ease-in-out",
  "from": { "x": 0.2, "y": 0.5 },
  "keyframes": [
    { "at": 0.35, "x": 0.4, "y": 0.18 },
    { "at": 0.7, "x": 0.7, "y": 0.3 }
  ],
  "to": { "x": 0.82, "y": 0.6 }
}
```

Allowed easing: `linear`, `ease-in`, `ease-out`, `ease-in-out`.
Keys must be **strictly increasing** in `at` (each strictly between 0 and 1)
and have finite x/y coordinates between 0 and 1. More than four intermediate
keys are rejected. Tap gestures cannot have keyframes. Older project gesture
JSON with only `from` and `to` continues to behave the same.

The inspector can add, edit or remove individual keys. A separate orange
handle appears at each intermediate keyframe in the visual gesture path editor.
Dragging a handle modifies only x/y; the inspector controls its time (`at`).
This authoring overlay is never included in output video.

## Portrait compatibility and rollout status

The editor offers 720×1280 and 1080×1920 output modes, and preview stage
aspect ratio tracks the selected output. The deterministic
`render-engine/viewport-fit.js` adapter fits the original 1920×1080
template composition into the portrait frame *without stretching or cropping
the source*. Additional space is filled with a dark gradient. Overlay gesture
coordinates are relative to the full output frame, not to the center-fitted
source stage.

**Important:** This is a *contain/letterbox* compatibility layout, not a
portrait-native rearrangement of Canvas text cards and artwork. High-quality
9:16 designs will require dedicated template layouts and visual review.
CI covers landscape and portrait MP4 encoding via Playwright/FFmpeg/FFprobe,
but production staging and user-content visual QA remain separate gates.
