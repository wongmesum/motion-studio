FROM mcr.microsoft.com/playwright:v1.64.1-jammy

WORKDIR /app

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

# Copy the lockfile too: `npm install` would re-resolve Playwright and could drift
# away from the pinned image tag, which breaks browser executable discovery.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
