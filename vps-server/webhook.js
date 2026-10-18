import axios from 'axios';
import crypto from 'crypto';
import { logger } from './logger.js';
import { getServiceKeys } from './config-store.js';

/**
 * Kirim Webhook Callback (dengan HMAC-SHA256 signature) saat job selesai atau gagal,
 * sehingga ChatGPT / orchestrator tidak wajib melakukan polling terus-menerus.
 */
export async function sendWebhookCallback(webhookUrl, payload) {
  const targetUrl = webhookUrl || process.env.WEBHOOK_URL;
  if (!targetUrl) return false;

  const serviceKeys = await getServiceKeys();
  const secret = serviceKeys.webhookSecret || process.env.WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('Webhook callback skipped because WEBHOOK_SECRET is not configured', {
      targetUrl,
      jobId: payload.job_id,
    });
    return false;
  }
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

  try {
    await axios.post(targetUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Motion-Signature': signature,
      },
      timeout: 10000,
    });
    logger.info('Webhook callback delivered', { targetUrl, jobId: payload.job_id });
    return true;
  } catch (e) {
    logger.warn('Webhook callback failed', { targetUrl, error: e.message });
    return false;
  }
}
