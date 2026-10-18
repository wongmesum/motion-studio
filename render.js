#!/usr/bin/env node
/**
 * ============================================================
 * MOTION STUDIO — Standalone CLI Renderer (Playwright + FFmpeg)
 * ============================================================
 * Merender file HTML animasi secara deterministik per-frame
 * dengan resolusi 1080p @ 60fps menggunakan Chromium + FFmpeg.
 *
 * Contoh penggunaan:
 *   node render.js
 *   node render.js --template render-engine/templates/kinetic-text.html --duration 10 --fps 60 --codec h264 --output output/promo.mp4
 *   node render.js --preview
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveFfmpegBinary } from './vps-server/ffmpeg.js';
import { validateLocalAudioPath } from './vps-server/security/audio-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ====== PARSE CLI ARGS ======
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[name] = true;
      } else {
        args[name] = next;
        i++;
      }
    }
  }
  return args;
}

const cli = parseArgs(process.argv);
const isPreview = Boolean(cli.preview);

// ====== KONFIGURASI ======
const CONFIG = {
  width: Number(cli.width || (isPreview ? 854 : process.env.RENDER_WIDTH || 1920)),
  height: Number(cli.height || (isPreview ? 480 : process.env.RENDER_HEIGHT || 1080)),
  fps: Number(cli.fps || (isPreview ? 15 : process.env.RENDER_FPS || 60)),
  duration: Number(cli.duration || process.env.RENDER_DURATION || 10),
  output: cli.output || (isPreview ? 'output/preview.mp4' : 'output/output.mp4'),
  framesDir: cli.framesDir || './frames/cli-job',
  htmlFile: cli.template || 'render-engine/templates/kinetic-text.html',
  audioFile: cli.audio || null,
  audioPath: null,
  subtitleFile: cli.subtitles || null,
  lutFile: cli.lut || null,
  codec: cli.codec || process.env.RENDER_CODEC || 'h264',
  crf: Number(cli.crf || (isPreview ? 26 : process.env.RENDER_CRF || 18)),
  preset: cli.preset || (isPreview ? 'ultrafast' : process.env.RENDER_PRESET || 'slow'),
  frameFormat: cli.format || 'jpeg', // 'jpeg' (3x lebih cepat) atau 'png'
  jpegQuality: Number(cli.quality || 95),
  parallel: Number(cli.parallel || Math.max(1, Math.min(os.cpus().length - 1, 6))),
  keepFrames: Boolean(cli.keepFrames || process.env.KEEP_FRAMES === 'true'),
};

// ====== CODEC MAP (Sesuai Peta Stack) ======
function getCodecArgs(codec, preset, crf) {
  switch (codec.toLowerCase()) {
    case 'h265':
    case 'hevc':
      return [
        '-c:v', 'libx265',
        '-preset', preset,
        '-crf', String(crf || 20),
        '-tag:v', 'hvc1',
        '-x265-params', 'log-level=error:frame-threads=4',
      ];
    case 'av1':
    case 'svtav1':
      return [
        '-c:v', 'libsvtav1',
        '-preset', '6',
        '-crf', String(crf || 30),
        '-svtav1-params', 'tune=0',
      ];
    case 'nvenc':
      return [
        '-c:v', 'h264_nvenc',
        '-preset', 'p7',
        '-tune', 'hq',
        '-cq', String(crf || 19),
        '-rc-lookahead', '32',
        '-spatial-aq', '1',
        '-temporal-aq', '1',
      ];
    case 'h264':
    default:
      return [
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', String(crf || 18),
        '-profile:v', 'high',
        '-level', '4.2',
        '-threads', '0',
      ];
  }
}

// ====== CHUNK HELPER ======
function splitIntoChunks(totalFrames, workerCount) {
  const chunks = [];
  const chunkSize = Math.ceil(totalFrames / workerCount);
  for (let start = 0; start < totalFrames; start += chunkSize) {
    chunks.push({
      start,
      end: Math.min(start + chunkSize, totalFrames),
    });
  }
  return chunks;
}

// ====== RENDER FRAMES (PARALLEL CHUNKED) ======
async function renderFrames() {
  const framesDirAbs = path.resolve(__dirname, CONFIG.framesDir);
  await fs.rm(framesDirAbs, { recursive: true, force: true });
  await fs.mkdir(framesDirAbs, { recursive: true });

  const totalFrames = Math.round(CONFIG.fps * CONFIG.duration);
  const workerCount = Math.min(CONFIG.parallel, totalFrames);
  const chunks = splitIntoChunks(totalFrames, workerCount);
  const ext = CONFIG.frameFormat === 'png' ? 'png' : 'jpg';

  console.log(`🎬 Motion Studio CLI Renderer`);
  console.log(`   Template : ${CONFIG.htmlFile}`);
  console.log(`   Resolusi : ${CONFIG.width}x${CONFIG.height} @ ${CONFIG.fps}fps (${CONFIG.duration}s = ${totalFrames} frames)`);
  console.log(`   Workers  : ${workerCount} parallel Chromium instances`);
  console.log(`   Codec    : ${CONFIG.codec.toUpperCase()} (CRF ${CONFIG.crf}, preset ${CONFIG.preset})`);

  const htmlAbsPath = path.resolve(__dirname, CONFIG.htmlFile);
  const htmlUrl = 'file://' + htmlAbsPath.replace(/\\/g, '/');

  let completedFrames = 0;

  const browsers = await Promise.all(
    chunks.map(() =>
      chromium.launch({
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--use-gl=swiftshader',
          '--enable-webgl',
          '--ignore-gpu-blocklist',
          '--font-render-hinting=none',
          '--force-color-profile=srgb',
          '--disable-lcd-text',
        ],
      })
    )
  );

  try {
    await Promise.all(
      chunks.map(async (chunk, idx) => {
        const browser = browsers[idx];
        const page = await browser.newPage({
          viewport: { width: CONFIG.width, height: CONFIG.height },
          deviceScaleFactor: 1,
        });

        await page.goto(htmlUrl, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);

        for (let i = chunk.start; i < chunk.end; i++) {
          const t = i / CONFIG.fps;
          await page.evaluate((time) => {
            if (typeof window.renderFrame === 'function') {
              window.renderFrame(time);
            }
          }, t);

          const frameName = `frame-${String(i).padStart(5, '0')}.${ext}`;
          const screenshotOpts = {
            path: path.join(framesDirAbs, frameName),
            type: CONFIG.frameFormat === 'png' ? 'png' : 'jpeg',
          };
          if (screenshotOpts.type === 'jpeg') {
            screenshotOpts.quality = CONFIG.jpegQuality;
          } else {
            screenshotOpts.omitBackground = false;
          }

          await page.screenshot(screenshotOpts);
          completedFrames++;

          if (completedFrames % 15 === 0 || completedFrames === totalFrames) {
            const pct = ((completedFrames / totalFrames) * 100).toFixed(1);
            process.stdout.write(`\r   ⏳ Frame ${completedFrames}/${totalFrames} (${pct}%)`);
          }
        }

        await page.close();
      })
    );
    console.log('\n✓ Semua frame selesai dirender');
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
  }
}

// ====== ENCODE FFMPEG ======
async function encodeVideo() {
  const outputAbs = path.resolve(__dirname, CONFIG.output);
  await fs.mkdir(path.dirname(outputAbs), { recursive: true });

  const ext = CONFIG.frameFormat === 'png' ? 'png' : 'jpg';
  const framesPattern = path.resolve(__dirname, CONFIG.framesDir, `frame-%05d.${ext}`);

  const args = [
    '-y',
    '-framerate', String(CONFIG.fps),
    '-i', framesPattern,
  ];

  if (CONFIG.audioPath) {
    args.push('-i', CONFIG.audioPath);
  }

  // Video filter pipeline (LUT / Subtitles)
  const vfFilters = [];
  if (CONFIG.lutFile) {
    vfFilters.push(`lut3d=${CONFIG.lutFile}`);
  }
  if (CONFIG.subtitleFile) {
    vfFilters.push(`subtitles=${CONFIG.subtitleFile}:force_style='FontSize=24,PrimaryColour=&H00FFFFFF'`);
  }
  if (vfFilters.length > 0) {
    args.push('-vf', vfFilters.join(','));
  }

  // Audio filter pipeline (Loudnorm + Fade)
  if (CONFIG.audioPath) {
    const fadeOutStart = Math.max(0, CONFIG.duration - 1.5);
    args.push(
      '-af',
      `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.8,afade=t=out:st=${fadeOutStart}:d=1.5`,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest'
    );
  }

  // Video Codec Args
  args.push(...getCodecArgs(CONFIG.codec, CONFIG.preset, CONFIG.crf));

  // Flags wajib untuk smooth playback
  args.push(
    '-g', String(CONFIG.fps), // keyframe tiap 1 detik
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-r', String(CONFIG.fps),
    outputAbs
  );

  console.log('🎞️  Encoding dengan FFmpeg...');
  return new Promise((resolve, reject) => {
    const ff = spawn(resolveFfmpegBinary(), args);
    ff.stderr.on('data', (d) => {
      const line = d.toString();
      if (line.includes('frame=') || line.includes('Error')) {
        process.stderr.write(`\r   ${line.trim().slice(0, 90)}`);
      }
    });
    ff.on('error', (error) => {
      reject(new Error(`Failed to start FFmpeg: ${error.message}`));
    });
    ff.on('close', (code) => {
      process.stderr.write('\n');
      if (code === 0) resolve(outputAbs);
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}

// ====== MAIN ======
(async () => {
  const start = Date.now();
  try {
    if (CONFIG.audioFile) {
      CONFIG.audioPath = await validateLocalAudioPath(CONFIG.audioFile, {
        allowedDirectories: [__dirname],
      });
    }
    await renderFrames();
    const outPath = await encodeVideo();

    if (!CONFIG.keepFrames) {
      await fs.rm(path.resolve(__dirname, CONFIG.framesDir), { recursive: true, force: true });
    }

    const sec = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ Selesai dalam ${sec}s → ${outPath}`);
  } catch (err) {
    console.error(`\n❌ Render gagal: ${err.message}`);
    process.exit(1);
  }
})();
