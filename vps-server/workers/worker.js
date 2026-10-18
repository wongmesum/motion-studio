import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { renderJob } from '../renderer.js';
import { sendWebhookCallback } from '../webhook.js';
import { logger, metrics } from '../logger.js';

const redis = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  'motion-render',
  async (job) => {
    const jobId = job.data.jobId || job.id;
    logger.info('Worker picked up render job', { jobId });

    const result = await renderJob(jobId, job.data, async (progressUpdate) => {
      await job.updateProgress(progressUpdate);
    });

    if (job.data.webhook_url) {
      await sendWebhookCallback(job.data.webhook_url, result);
    }

    return result;
  },
  {
    connection: redis,
    concurrency: 2,
  }
);

worker.on('completed', (job) => {
  logger.info('Worker completed job', { jobId: job.id });
});

worker.on('failed', async (job, err) => {
  metrics.jobsFailedTotal += 1;
  logger.error('Worker failed job', { jobId: job?.id, error: err.message });
  if (job?.data?.webhook_url) {
    await sendWebhookCallback(job.data.webhook_url, {
      job_id: job.id,
      status: 'failed',
      error: err.message,
    });
  }
});

logger.info('Motion Studio Distributed BullMQ Worker started (concurrency: 2)');
