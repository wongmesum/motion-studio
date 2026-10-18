import crypto from 'crypto';
import { renderJob } from './renderer.js';
import { sendWebhookCallback } from './webhook.js';
import { logger, metrics } from './logger.js';

/**
 * Queue Manager (Mendukung BullMQ + Redis untuk Distributed Cluster,
 * dan otomatis fallback ke In-Memory Queue jika Redis tidak tersedia).
 */
const inMemoryJobs = new Map();
const deadLetterQueue = [];
let bullQueue = null;
let usingRedis = false;

export async function initQueue() {
  if (process.env.REDIS_ENABLED === 'false') {
    logger.info('Queue initialized in Standalone In-Memory mode (REDIS_ENABLED=false)');
    return { mode: 'memory' };
  }

  try {
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;

    const redis = new IORedis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
      connectTimeout: 3000,
      retryStrategy: () => null, // fallback cepat jika Redis tidak aktif
    });

    await new Promise((resolve, reject) => {
      redis.once('ready', resolve);
      redis.once('error', reject);
    });

    bullQueue = new Queue('motion-render', { connection: redis });
    usingRedis = true;
    logger.info('Queue connected to Redis (BullMQ mode)');
    return { mode: 'redis', queue: bullQueue };
  } catch (e) {
    logger.warn('Redis unavailable, falling back to In-Memory Queue', { reason: e.message });
    usingRedis = false;
    return { mode: 'memory' };
  }
}

export async function enqueueRenderJob(jobPayload) {
  metrics.jobsSubmittedTotal += 1;
  const jobId = `job-${crypto.randomBytes(4).toString('hex')}`;

  if (usingRedis && bullQueue) {
    const job = await bullQueue.add('motion', { ...jobPayload, jobId }, {
      jobId,
      priority: Number(jobPayload.priority || 5),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return { job_id: job.id, mode: 'redis_bullmq', status: 'queued' };
  }

  // Fallback In-Memory Queue
  const record = {
    job_id: jobId,
    status: 'queued',
    progress: 0,
    created_at: new Date().toISOString(),
    payload: jobPayload,
    result: null,
    error: null,
  };
  inMemoryJobs.set(jobId, record);

  // Jalankan secara asinkron di background
  setImmediate(async () => {
    try {
      record.status = 'processing';
      const res = await renderJob(jobId, jobPayload, (update) => {
        Object.assign(record, update);
      });
      record.status = 'completed';
      record.progress = 100;
      record.result = res;
      if (jobPayload.webhook_url) {
        await sendWebhookCallback(jobPayload.webhook_url, res);
      }
    } catch (err) {
      metrics.jobsFailedTotal += 1;
      record.status = 'failed';
      record.error = err.message;
      deadLetterQueue.push({ job_id: jobId, error: err.message, failed_at: new Date().toISOString() });
      logger.error('In-memory render job failed', { jobId, error: err.message });
      if (jobPayload.webhook_url) {
        await sendWebhookCallback(jobPayload.webhook_url, {
          job_id: jobId,
          status: 'failed',
          error: err.message,
        });
      }
    }
  });

  return { job_id: jobId, mode: 'in_memory', status: 'queued' };
}

export async function getJobStatus(jobId) {
  if (usingRedis && bullQueue) {
    const job = await bullQueue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    return {
      job_id: job.id,
      status: state,
      progress: job.progress || 0,
      result: job.returnvalue || null,
      error: job.failedReason || null,
    };
  }

  return inMemoryJobs.get(jobId) || null;
}

export async function getQueueStats() {
  if (usingRedis && bullQueue) {
    const waiting = await bullQueue.getWaitingCount();
    const active = await bullQueue.getActiveCount();
    const completed = await bullQueue.getCompletedCount();
    const failed = await bullQueue.getFailedCount();
    return { mode: 'redis_bullmq', waiting, active, completed, failed };
  }

  let waiting = 0, active = 0, completed = 0, failed = 0;
  for (const job of inMemoryJobs.values()) {
    if (job.status === 'queued') waiting++;
    else if (job.status === 'completed') completed++;
    else if (job.status === 'failed') failed++;
    else active++;
  }
  return {
    mode: 'in_memory',
    waiting,
    active,
    completed,
    failed,
    deadLetterCount: deadLetterQueue.length,
  };
}
