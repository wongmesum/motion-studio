import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { higgsfieldImage, higgsfieldVideo } from './tools/higgsfield.js';
import { vpsRender, vpsJobStatus, vpsListTemplates } from './tools/vps-render.js';
import { askDeepSeek } from './tools/deepseek.js';

const server = new Server(
  { name: 'motion-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ============ DAFTAR MCP TOOLS ============
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'higgsfield_generate_image',
      description: 'Generate gambar AI resolusi tinggi (1080p/4K) via Higgsfield. Mengembalikan URL gambar siap pakai untuk background/asset motion graphics.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Deskripsi visual gambar (bahasa Inggris direkomendasikan)' },
          width:  { type: 'number', default: 1920 },
          height: { type: 'number', default: 1080 },
          model:  { type: 'string', default: 'soul', description: 'Model Higgsfield (soul, cinematic, anime)' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'higgsfield_generate_video',
      description: 'Generate klip video AI via Higgsfield (text-to-video atau image-to-video) untuk digabungkan ke komposisi motion graphics.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt:       { type: 'string', description: 'Deskripsi gerakan / adegan video' },
          source_image: { type: 'string', description: 'URL gambar sumber untuk image-to-video (opsional)' },
          duration:     { type: 'number', default: 5, description: 'Durasi klip dalam detik (3-10)' },
          aspect_ratio: { type: 'string', default: '16:9' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'vps_render_motion',
      description: 'Kirim job render motion graphics ke VPS Render Farm (otomatis melewati DeepSeek 5-Stage Engineer Gate sebelum dirender dengan Playwright + FFmpeg). Mengembalikan job_id.',
      inputSchema: {
        type: 'object',
        properties: {
          html:        { type: 'string', description: 'Kode HTML animasi lengkap dengan fungsi window.renderFrame(t)' },
          template:    { type: 'string', description: 'Atau pilih nama template siap pakai: base, kinetic-text, image-slideshow, video-mixer' },
          goal:        { type: 'string', description: 'Deskripsi tujuan visual untuk panduan DeepSeek Engineer' },
          duration:    { type: 'number', default: 10, description: 'Durasi video dalam detik' },
          fps:         { type: 'number', default: 60, description: 'Frame per second (30 / 60)' },
          width:       { type: 'number', default: 1920 },
          height:      { type: 'number', default: 1080 },
          assets:      { type: 'array', items: { type: 'string' }, description: 'Daftar URL gambar/video dari Higgsfield' },
          audio_url:   { type: 'string', description: 'URL HTTPS audio MP3/WAV/M4A/AAC dari hostname dalam RENDER_ALLOWED_HOSTS (opsional)' },
          codec:       { type: 'string', default: 'h264', description: 'Codec output: h264, h265, av1, nvenc' },
          preview:     { type: 'boolean', default: false, description: 'Jika true, render cepat 480p @ 15fps untuk preview' },
          priority:    { type: 'number', default: 5, description: 'Prioritas antrean (1 = tertinggi VIP, 10 = terendah)' },
          webhook_url: { type: 'string', description: 'URL callback saat job selesai (opsional)' },
        },
        required: ['html'],
      },
    },
    {
      name: 'vps_job_status',
      description: 'Cek status, progress frame-by-frame, laporan DeepSeek Engineer, dan URL hasil MP4 dari job render di VPS.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'ID job yang dikembalikan oleh vps_render_motion' },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'vps_list_templates',
      description: 'Lihat daftar template motion graphics siap pakai di VPS (GSAP, Kinetic Glitch, Slideshow, Canvas 2D Video Mixer).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'deepseek_fix_animation',
      description: 'Panggil DeepSeek Render Engineer secara langsung untuk membuat, mengoptimasi, atau memperbaiki kode HTML animasi agar deterministik 60fps.',
      inputSchema: {
        type: 'object',
        properties: {
          html:  { type: 'string', description: 'Kode HTML awal (opsional jika ingin generate dari awal)' },
          error: { type: 'string', description: 'Pesan error saat render (opsional)' },
          goal:  { type: 'string', description: 'Spesifikasi animasi yang diinginkan' },
        },
        required: ['goal'],
      },
    },
  ],
}));

// ============ HANDLER EKSEKUSI TOOL ============
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    switch (name) {
      case 'higgsfield_generate_image':
        result = await higgsfieldImage(args);
        break;
      case 'higgsfield_generate_video':
        result = await higgsfieldVideo(args);
        break;
      case 'vps_render_motion':
        result = await vpsRender(args);
        break;
      case 'vps_job_status':
        result = await vpsJobStatus(args);
        break;
      case 'vps_list_templates':
        result = await vpsListTemplates();
        break;
      case 'deepseek_fix_animation':
        result = await askDeepSeek(args);
        break;
      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: e.message }, null, 2) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
