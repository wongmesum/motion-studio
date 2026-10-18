#!/bin/bash
set -u

failures=0
FFMPEG_BIN="${FFMPEG_PATH:-ffmpeg}"
FFPROBE_BIN="${FFPROBE_PATH:-ffprobe}"

echo "Verifying Motion Studio runtime stack..."
echo ""

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "OK $2: $($1 $3 2>&1 | head -1)"
  else
    echo "MISSING $2"
    failures=$((failures + 1))
  fi
}

check_binary() {
  local binary="$1"
  local label="$2"
  if "$binary" -version >/dev/null 2>&1; then
    echo "OK $label: $($binary -version 2>&1 | head -1)"
  else
    echo "MISSING $label: $binary"
    failures=$((failures + 1))
  fi
}

check_encoder() {
  local encoder="$1"
  local required="$2"
  if "$FFMPEG_BIN" -hide_banner -encoders 2>/dev/null | grep -qE "[[:space:]]${encoder}[[:space:]]"; then
    echo "OK encoder $encoder"
  elif [ "$required" = "required" ]; then
    echo "MISSING required encoder $encoder"
    failures=$((failures + 1))
  else
    echo "OPTIONAL encoder $encoder unavailable"
  fi
}

echo "[1] PLAYWRIGHT + CANVAS 2D RENDER ENGINE"
check_command node "Node.js" "--version"
check_command npx "Playwright CLI" "playwright --version"
echo ""

echo "[2] FFMPEG COMPOSITOR"
[ -n "${FFMPEG_PATH:-}" ] && echo "FFMPEG_PATH: $FFMPEG_PATH"
check_binary "$FFMPEG_BIN" "FFmpeg"
check_binary "$FFPROBE_BIN" "FFprobe"
echo ""

echo "[3] ENCODERS"
check_encoder libx264 required
check_encoder aac required
check_encoder libx265 optional
check_encoder libsvtav1 optional
check_encoder h264_nvenc optional
echo ""

echo "[4] MOTION TEMPLATES"
[ -f render-engine/templates/base.html ] && echo "OK GSAP template"
[ -f render-engine/templates/kinetic-text.html ] && echo "OK Kinetic Glitch template"
[ -f render-engine/templates/image-slideshow.html ] && echo "OK Slideshow template"
[ -f render-engine/templates/video-mixer.html ] && echo "OK Canvas 2D Video Mixer template"
echo ""

echo "[5] SERVICES"
[ -f vps-server/deepseek-engineer.js ] && echo "OK AI Engineer"
[ -f mcp-server/index.js ] && echo "OK MCP Server"

if [ "$failures" -gt 0 ]; then
  echo ""
  echo "Stack verification failed: $failures required capability missing"
  exit 1
fi

echo ""
echo "Stack verification passed"
