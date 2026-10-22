#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compileProject } from '../vps-server/studio/compile-project.js';

function command(file, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: 'pipe', env: process.env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', c => { stdout += c; });
    p.stderr.on('data', c => { stderr += c; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(file + ' exited ' + code + '\\n' + stderr.slice(-4000))));
  });
}

// CI checks both landscape and portrait H.264 output with FFprobe.
// These tiny encodes prove the full Playwright -> PNG -> FFmpeg chain.
async function smoke({ width, height, frameCount }) {
  const project = {
    schemaVersion: 1, title: 'CI MP4 smoke', template: 'base',
    render: { fps: 8, width, height, codec: 'h264' },
    scenes: [{ durationSec: frameCount / 8, transition: { type: 'none', durationSec: 0 },
      gestures: [{ type: 'swipe', effect: 'sunburst-star', startSec: 0,
        durationSec: frameCount / 8, from: { x: 0.35, y: 0.45 },
        to: { x: 0.65, y: 0.55 }, easing: 'ease-in-out',
        keyframes: [{ at: 0.5, x: 0.5, y: 0.2 }] }],
      elements: [
        { type: 'text', role: 'title', text: 'CI MOTION',
          motion: { preset: 'fade-in', startSec: 0, durationSec: Math.min(0.5, frameCount / 8) } }
      ] }]
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-mp4-'));
  try {
    const { html } = await compileProject(project, {
      target: 'render',
      readTemplate: () => fs.readFile(path.resolve('render-engine/templates/base.html'), 'utf8')
    });
    const template = path.join(dir, 'compiled.html');
    const output = path.join(dir, 'motion.mp4');
    await fs.writeFile(template, html);
    await command(process.execPath, [
      path.resolve('render.js'), '--template', template,
      '--duration', String(frameCount / 8), '--fps', '8',
      '--width', String(width), '--height', String(height),
      '--parallel', '1', '--quality', '65', '--preset', 'ultrafast',
      '--output', output, '--framesDir', path.join(dir, 'frames')
    ]);
    const info = await command('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,nb_frames',
      '-of', 'json', output
    ]);
    const stream = JSON.parse(info).streams?.[0];
    if (stream?.codec_name !== 'h264' || stream?.width !== width || stream?.height !== height
      || Number(stream?.nb_frames) !== frameCount) {
      throw new Error('Unexpected MP4 stream: ' + JSON.stringify(stream));
    }
    console.log('MP4 smoke successful: H264 ' + width + 'x' + height + ', ' + frameCount + ' frames');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

await smoke({ width: 1920, height: 1080, frameCount: 8 });
await smoke({ width: 1080, height: 1920, frameCount: 4 });
