FROM mcr.microsoft.com/playwright:v1.64.1-jammy

# Install FFmpeg, ImageMagick, Sox, Mesa llvmpipe (Software GPU fallback)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    imagemagick \
    sox \
    libsox-fmt-all \
    mesa-utils \
    libgl1-mesa-dri \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV LIBGL_ALWAYS_SOFTWARE=1
ENV GALLIUM_DRIVER=llvmpipe

WORKDIR /app/vps-server

# Copy the lockfile too: `npm install` would re-resolve Playwright and could drift
# away from the pinned image tag, which breaks browser executable discovery.
COPY vps-server/package.json vps-server/package-lock.json ./
RUN npm ci --omit=dev

COPY vps-server/ ./

# The server resolves these as siblings of vps-server/, so the image must keep the
# repository layout instead of flattening everything into /app.
WORKDIR /app
COPY admin-dashboard.html preview-studio.html ./
COPY render-engine/ ./render-engine/
COPY studio-assets/ ./studio-assets/

EXPOSE 3000

CMD ["node", "vps-server/server.js"]
