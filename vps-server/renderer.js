import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getCachedRender, saveRenderToCache } from './cache.js';
import { prepareAssets, prepareAudioAsset, publishOutput } from './storage.js';
import { runEngineerPipeline } from './deepseek-engineer.js';
import { logger, metrics, recordRenderDuration } from './logger.js';
import { resolveFfmpegBinary } from './ffmpeg.js';
import { buildAudioInputArgs } from './renderer-args.js';
import { applyRenderNetworkPolicy } from './security/network-policy.js';

const CPU_CORES = os.cpus().length;
const DEFAULT_PARALLEL = Number(process.env.RENDER_PARALLEL) || Math.max(1, Math.min(CPU_CORES - 1, 8));

const CODEC_MAP = {
  h264: (preset, crf) => [
    '-c:v', 'libx264',
    '-preset', preset || 'slow',
    '-crf', String(crf ?? 18),
    '-profile:v', 'high',
    '-level', '4.2',
    '-threads', '0',
    '-x264-params', `threads=${Math.max(2, CPU_CORES)}:sliced-threads=1`,
  ],
  h265: (preset, crf) => [
    '-c:v', 'libx265',
    '-preset', preset || 'slow',
    '-crf', String(crf ?? 20),
    '-tag:v', 'hvc1',
    '-x265-params', 'log-level=error:frame-threads=4',
  ],
  av1: (_preset, crf) => [
    '-c:v', 'libsvtav1',
    '-preset', '6',
    '-crf', String(crf ?? 30),
    '-svtav1-params', 'tune=0:film-grain=8',
  ],
  nvenc: (_preset, crf) => [
    '-c:v', 'h264_nvenc',
    '-preset', 'p7',
    '-tune', 'hq',
    '-cq', String(crf ?? 19),
    '-rc-lookahead', '32',
    '-spatial-aq', '1',
    '-temporal-aq', '1',
  ],
};

function splitIntoChunks(totalFrames, count) {
  const chunks = [];
  const size = Math.ceil(totalFrames / count);
  for (let start = 0; start < totalFrames; start += size) {
    chunks.push({ start, end: Math.min(start + size, totalFrames) });
  }
  return chunks;
}

/**
 * Render chunk frame menggunakan 1 instance Chromium (menghemat overhead launch)
 */
async function renderChunk(browser, html, startFrame, endFrame, fps, width, height, framesDir, onFrameDone) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  await applyRenderNetworkPolicy(page);

  await page.setContent(html, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(200);

  for (let i = startFrame; i < endFrame; i++) {
    const t = i / fps;
    await page.evaluate((time) => {
      if (typeof window.renderFrame === 'function') {
        window.renderFrame(time);
      }
    }, t);

    const frameFile = path.join(framesDir, `frame-${String(i).padStart(5, '0')}.jpg`);
    await page.screenshot({
      path: frameFile,
      type: 'jpeg',
      quality: 95,
    });

    onFrameDone(i);
  }

  await page.close();
}

/**
 * Encode urutan frame JPEG menjadi MP4 menggunakan FFmpeg
 */
function encodeVideoFFmpeg({ framesDir, outputFile, fps, codec, preset, crf, audioPath }) {
  return new Promise((resolve, reject) => {
    const codecBuilder = CODEC_MAP[codec] || CODEC_MAP.h264;
    const args = [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(framesDir, 'frame-%05d.jpg'),
    ];

    args.push(...buildAudioInputArgs(audioPath));

    args.push(
      ...codecBuilder(preset, crf),
      '-g', String(fps),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-r', String(fps),
      outputFile
    );

    const ff = spawn(resolveFfmpegBinary(), args);
    let stderrLog = '';
    // A spawn failure emits both 'error' and 'close'; count the failure once.
    let failureRecorded = false;
    const recordFailure = () => {
      if (failureRecorded) return;
      failureRecorded = true;
      metrics.ffmpegFailuresTotal += 1;
    };

    ff.stderr.on('data', (d) => {
      stderrLog += d.toString();
    });
    ff.on('error', (error) => {
      recordFailure();
      reject(new Error(`Failed to start FFmpeg: ${error.message}`));
    });
    ff.on('close', (code) => {
      if (code === 0) {
        resolve(outputFile);
      } else {
        recordFailure();
        reject(new Error(`FFmpeg exited with code ${code}: ${stderrLog.slice(-300)}`));
      }
    });
  });
}

/**
 * Pipeline Eksekusi Job Render Lengkap:
 * 1. Cek Content-Addressable Cache
 * 2. Download & Optimasi Asset via Sharp
 * 3. Jalankan DeepSeek 5-Stage Render Engineer Gate
 * 4. Parallel Chunked Rendering dengan Playwright
 * 5. Encode MP4 dengan FFmpeg
 * 6. Upload ke MinIO / Publikasikan URL
 */
export async function renderJob(jobId, jobData, onProgress = () => {}) {
  const startTime = Date.now();
  const isPreview = Boolean(jobData.preview);

  const width = Number(jobData.width || (isPreview ? 854 : process.env.RENDER_WIDTH || 1920));
  const height = Number(jobData.height || (isPreview ? 480 : process.env.RENDER_HEIGHT || 1080));
  const fps = Number(jobData.fps || (isPreview ? 15 : process.env.RENDER_FPS || 60));
  const duration = Number(jobData.duration || process.env.RENDER_DURATION || 10);
  const codec = (jobData.codec || process.env.RENDER_CODEC || 'h264').toLowerCase();
  const preset = isPreview ? 'ultrafast' : (jobData.preset || process.env.RENDER_PRESET || 'slow');
  const crf = Number(jobData.crf || (isPreview ? 26 : process.env.RENDER_CRF || 18));

  const outputDir = path.resolve(process.cwd(), 'output');
  const framesDir = path.resolve(process.cwd(), 'frames', jobId);
  const outputFile = path.join(outputDir, `${jobId}.mp4`);

  await fs.mkdir(outputDir, { recursive: true });

  // 1. Cek Cache Content-Addressable
  onProgress({ status: 'checking_cache', progress: 2 });
  const cacheCheck = await getCachedRender({
    ...jobData,
    width,
    height,
    fps,
    duration,
    codec,
    preview: isPreview,
  });

  if (cacheCheck.hit) {
    await fs.copyFile(cacheCheck.path, outputFile);
    const published = await publishOutput(jobId, outputFile);
    onProgress({ status: 'completed', progress: 100, cached: true, url: published.url });
    return {
      job_id: jobId,
      status: 'completed',
      cached: true,
      hash: cacheCheck.hash,
      url: published.url,
      storage: published.storage,
      duration_sec: ((Date.now() - startTime) / 1000).toFixed(2),
    };
  }

  // 2. Download & Optimasi Assets (Sharp)
  onProgress({ status: 'preparing_assets', progress: 8 });
  const [preparedAssets, preparedAudio] = await Promise.all([
    prepareAssets(jobData.assets || [], width, height),
    jobData.audio_url ? prepareAudioAsset(jobData.audio_url) : null,
  ]);

  // Ganti URL remote di HTML dengan path file lokal yang sudah di-cache jika ada
  let workingHtml = jobData.html;
  for (const item of preparedAssets) {
    if (!item.fallbackRemote && item.localPath) {
      const fileUrl = 'file://' + item.localPath.replace(/\\/g, '/');
      workingHtml = workingHtml.split(item.originalUrl).join(fileUrl);
    }
  }

  // 3. DeepSeek 5-Stage Render Engineer Gate
  let engineerReport = null;
  if (process.env.DEEPSEEK_ENABLED !== 'false') {
    onProgress({ status: 'deepseek_engineering', progress: 15 });
    const engineered = await runEngineerPipeline(
      workingHtml,
      { width, height, fps, duration, goal: jobData.goal },
      (stage) => onProgress({ status: `deepseek_${stage}`, progress: 20 })
    );
    workingHtml = engineered.html;
    engineerReport = engineered.report;
  }

  // 4. Parallel Chunked Frame Rendering (Playwright)
  onProgress({ status: 'rendering_frames', progress: 25 });
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const totalFrames = Math.round(fps * duration);
  const parallelCount = Math.min(DEFAULT_PARALLEL, totalFrames);
  const chunks = splitIntoChunks(totalFrames, parallelCount);

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
        ],
      })
    )
  );

  let renderedCount = 0;
  try {
    await Promise.all(
      chunks.map((chunk, i) =>
        renderChunk(
          browsers[i],
          workingHtml,
          chunk.start,
          chunk.end,
          fps,
          width,
          height,
          framesDir,
          () => {
            renderedCount++;
            if (renderedCount % 10 === 0 || renderedCount === totalFrames) {
              const pct = Math.min(85, 25 + Math.round((renderedCount / totalFrames) * 60));
              onProgress({
                status: 'rendering_frames',
                progress: pct,
                renderedFrames: renderedCount,
                totalFrames,
              });
            }
          }
        )
      )
    );
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
  }

  // 5. Encode Video dengan FFmpeg
  onProgress({ status: 'encoding_ffmpeg', progress: 88 });
  await encodeVideoFFmpeg({
    framesDir,
    outputFile,
    fps,
    codec,
    preset,
    crf,
    audioPath: preparedAudio?.localPath || null,
  });

  // 6. Simpan ke Cache & Upload ke Storage
  onProgress({ status: 'publishing', progress: 96 });
  await saveRenderToCache(
    { ...jobData, width, height, fps, duration, codec, preview: isPreview },
    outputFile
  );
  const published = await publishOutput(jobId, outputFile);

  if (process.env.KEEP_FRAMES !== 'true') {
    await fs.rm(framesDir, { recursive: true, force: true });
  }

  const totalSec = Number(((Date.now() - startTime) / 1000).toFixed(2));
  recordRenderDuration(totalSec);
  metrics.jobsCompletedTotal += 1;

  const finalResult = {
    job_id: jobId,
    status: 'completed',
    progress: 100,
    cached: false,
    hash: cacheCheck.hash,
    url: published.url,
    storage: published.storage,
    resolution: `${width}x${height}`,
    fps,
    duration,
    codec,
    render_time_seconds: totalSec,
    deepseek_engineer: engineerReport,
  };

  onProgress(finalResult);
  logger.info('Render job completed', { jobId, totalSec, url: published.url });
  return finalResult;
}
