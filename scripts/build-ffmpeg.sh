#!/bin/bash
set -e

echo "🎞️  Installing Static FFmpeg Build (BtbN GPL — libx264, libx265, libsvtav1, nvenc)..."

TMP_DIR=$(mktemp -d)
cd "$TMP_DIR"

wget -q --show-progress https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz
sudo cp -f ffmpeg-master-latest-linux64-gpl/bin/ffmpeg /usr/local/bin/ffmpeg
sudo cp -f ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/ffprobe
sudo chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

cd -
rm -rf "$TMP_DIR"

echo "✅ FFmpeg installed:"
ffmpeg -version | head -n 2
