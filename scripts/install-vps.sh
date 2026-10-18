#!/bin/bash
set -e

echo "🚀 Installing Motion Studio Dependencies on Ubuntu VPS..."

# 1. Update System
sudo apt-get update && sudo apt-get upgrade -y

# 2. Install Node.js 20 LTS
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 3. Install Chromium Headless Dependencies + ImageMagick + Sox + Mesa Software GPU
sudo apt-get install -y \
  ffmpeg \
  imagemagick \
  sox \
  libsox-fmt-all \
  libsndfile1 \
  mesa-utils \
  libgl1-mesa-dri \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpango-1.0-0 \
  libcairo2 \
  fonts-liberation \
  fonts-noto-color-emoji \
  fonts-noto-cjk \
  zip \
  xz-utils

# 4. Install NPM Packages & Playwright Chromium
npm install
npx playwright install chromium --with-deps

# 5. Buat folder kerja
mkdir -p output cache frames render-engine/assets/fonts

echo "✅ VPS Setup Selesai! Jalankan 'bash scripts/verify-stack.sh' untuk cek semua komponen."
