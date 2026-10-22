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

const project = {
  schemaVersion: 1, title: 'CI portrait MP4 smoke', template: 'base',
  render: { fps: 4, width: 1080, height: 1920, codec: 'h264' },
  scenes: [{ durationSec: 1, transition: { type: 'none', durationSec: 0 },
    gestures: [{ type: 'tap', effect: 'sunburst-soft', startSec: 0,
      durationSec: 0.9, from: { x: 0.55, y: 0.45 }, to: { x: 0.55, y: 0.45 } }],
    elements: [
    { type: 'text', role: 'title', text: 'PORTRAIT MOTION',
      motion: { preset: 'none', startSec: 0, durationSec: 0.8, keyframes: [
        { timeSec: 0, x: 0, y: 60, scale: 0.8, opacity: 0 },
        { timeSec: 0.8, x: 0, y: 0, scale: 1, opacity: 1 }
      ] } }
  ] }]
};
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-mp4-'));
try {
  const { html } = await compileProject(project, {
    target: 'render',
    readTemplate: () => fs.readFile(path.resolve('render-engine/templates/base.html'), 'utf8')
  });
  const template = path.join(dir, 'compiled.html');
  const output = path.join(dir, 'portrait.mp4');
  await fs.writeFile(template, html);
  await command(process.execPath, [
    path.resolve('render.js'), '--template', template, '--duration', '1', '--fps', '4',
    '--width', '1080', '--height', '1920', '--parallel', '1', '--quality', '65',
    '--preset', 'ultrafast', '--output', output, '--framesDir', path.join(dir, 'frames')
  ]);
  const info = await command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,nb_frames',
    '-of', 'json', output
  ]);
  const stream = JSON.parse(info).streams?.[0];
  if (stream?.codec_name !== 'h264' || stream?.width !== 1080 || stream?.height !== 1920
    || Number(stream?.nb_frames) !== 4) {
    throw new Error('Unexpected MP4 stream: ' + JSON.stringify(stream));
  }
  if (process.env.MOTION_QA_OUTPUT_DIR) {
    const qaDir = path.resolve(process.env.MOTION_QA_OUTPUT_DIR);
    await fs.mkdir(qaDir, { recursive: true });
    await fs.copyFile(output, path.join(qaDir, 'portrait-1080x1920.mp4'));
  }
  console.log('MP4 smoke successful: H264 1080x1920, 4 frames');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
