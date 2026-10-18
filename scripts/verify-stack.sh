#!/bin/bash
echo "🔍 Verifying Motion Studio 5-Pillar Stack..."
echo ""

check() {
  if command -v "$1" &>/dev/null; then
    echo "✅ $2: $($1 $3 2>&1 | head -1)"
  else
    echo "❌ $2: NOT INSTALLED"
  fi
}

echo "━━━ [1] RENDER ENGINE ━━━"
check node "Node.js" "--version"
check npx  "Playwright CLI" "playwright --version"
ls ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null \
  && echo "✅ Chromium Headless: installed" \
  || echo "⚠️  Chromium: run 'npx playwright install chromium'"

echo ""
echo "━━━ [2] COMPOSITOR ━━━"
check ffmpeg "FFmpeg" "-version"
[ -f render-engine/remotion/Composition.jsx ] \
  && echo "✅ Remotion Composition: ready (render-engine/remotion/Composition.jsx)"

echo ""
echo "━━━ [3] ENCODER ━━━"
ffmpeg -version 2>/dev/null | grep -q "enable-libx264" \
  && echo "✅ libx264 (H.264): OK" || echo "⚠️  libx264: check ffmpeg build"
ffmpeg -version 2>/dev/null | grep -q "enable-libx265" \
  && echo "✅ libx265 (HEVC): OK" || echo "⚠️  libx265: check ffmpeg build"
ffmpeg -version 2>/dev/null | grep -q "enable-libsvtav1" \
  && echo "✅ SVT-AV1: OK" || echo "⚠️  SVT-AV1: run scripts/build-ffmpeg.sh"
ffmpeg -version 2>/dev/null | grep -q "enable-nvenc" \
  && echo "✅ NVENC: OK (GPU mode available)" || echo "ℹ️  NVENC: CPU-only mode active"

echo ""
echo "━━━ [4] MOTION LAYER ━━━"
[ -f render-engine/templates/base.html ] && echo "✅ GSAP Template: render-engine/templates/base.html"
[ -f render-engine/templates/kinetic-text.html ] && echo "✅ Kinetic Glitch Template: render-engine/templates/kinetic-text.html"
[ -f render-engine/templates/image-slideshow.html ] && echo "✅ Slideshow Template: render-engine/templates/image-slideshow.html"
[ -f render-engine/templates/video-mixer.html ] && echo "✅ 3D & Video Mixer Template: render-engine/templates/video-mixer.html"

echo ""
echo "━━━ [5] ASSET PIPELINE & AI ENGINEER ━━━"
check convert "ImageMagick" "-version"
check sox "SoX Audio" "--version"
[ -f vps-server/deepseek-engineer.js ] && echo "✅ DeepSeek 5-Stage Engineer: ready"
[ -f mcp-server/index.js ] && echo "✅ ChatGPT MCP Server: ready"
echo ""
echo "🎉 Stack verification complete!"
