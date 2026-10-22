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
