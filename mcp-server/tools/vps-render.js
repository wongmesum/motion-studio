import axios from 'axios';
import crypto from 'crypto';

const VPS_ENDPOINT = process.env.VPS_ENDPOINT || 'http://localhost:3000';

function getRequiredSecret(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function buildHeaders(bodyObj = null) {
  const headers = {
    'X-Token': getRequiredSecret('VPS_TOKEN'),
    'Content-Type': 'application/json',
  };
  const hmacSecret = process.env.HMAC_SECRET;
  if (bodyObj && hmacSecret) {
    const raw = JSON.stringify(bodyObj);
    headers['X-Signature'] = crypto
      .createHmac('sha256', hmacSecret)
      .update(raw)
      .digest('hex');
  } else if (bodyObj && process.env.REQUIRE_HMAC_SIGNATURE === 'true') {
    throw new Error('HMAC_SECRET is not configured');
  }
  return headers;
}

/**
 * Kirim job render motion graphics ke VPS Render Server.
 */
export async function vpsRender(args) {
  const payload = {
    html: args.html,
    template: args.template || null,
    goal: args.goal || 'Smooth 1080p deterministic motion graphics',
    duration: args.duration ?? 10,
    fps: args.fps ?? 60,
    width: args.width ?? 1920,
    height: args.height ?? 1080,
    assets: args.assets ?? [],
    audio_url: args.audio_url || null,
    codec: args.codec ?? 'h264',
    preview: Boolean(args.preview),
    priority: args.priority ?? 5,
    webhook_url: args.webhook_url || null,
  };

  const res = await axios.post(`${VPS_ENDPOINT}/render`, payload, {
    headers: buildHeaders(payload),
    timeout: 30000,
  });

  return res.data;
}

/**
 * Cek status job render di VPS.
 */
export async function vpsJobStatus(args) {
  const { job_id } = args;
  const res = await axios.get(`${VPS_ENDPOINT}/jobs/${encodeURIComponent(job_id)}`, {
    headers: buildHeaders(),
    timeout: 15000,
  });
  return res.data;
}

/**
 * Ambil daftar template motion graphics yang tersedia di VPS.
 */
export async function vpsListTemplates() {
  const res = await axios.get(`${VPS_ENDPOINT}/templates`, {
    headers: buildHeaders(),
    timeout: 15000,
  });
  return res.data;
}
