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
// Redis was configured but unreachable at startup. Work still runs in process, but the
// deployment is not the one that was asked for, so health must say so rather than
// reporting healthy while the distributed queue is silently absent.
let redisFallback = false;

// Bounded exponential backoff. Returning null on the first failure (the previous
// behaviour) told ioredis to give up permanently, so a single Redis restart left the
// API unable to enqueue or report stats until it was restarted too.
const REDIS_RECONNECT_BASE_MS = 200;
const REDIS_RECONNECT_MAX_MS = 10_000;
const REDIS_COMMAND_TIMEOUT_MS = 5000;

export function createRedisOptions(env = process.env) {
  return {
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    // API requests must fail instead of waiting through an unbounded outage. The worker
    // uses its own BullMQ connection with maxRetriesPerRequest=null as BullMQ requires.
    maxRetriesPerRequest: 1,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout: 3000,
    retryStrategy: (attempt) =>
      Math.min(REDIS_RECONNECT_BASE_MS * 2 ** (attempt - 1), REDIS_RECONNECT_MAX_MS),
  };
}

// A Redis outage is a server-side dependency failure, not a bad request. Callers that
// retry on 5xx must not be told their payload was invalid.
export class QueueUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'QueueUnavailableError';
    this.statusCode = 503;
  }
}

/**
 * Re-arms the Redis connection after a failed startup instead of staying in single-process
 * memory mode forever. A Redis restart that overlaps the API's own start (or a container
 * boot ordering race) would otherwise downgrade the deployment permanently, because
 * `initQueue` only runs once.
 */
const REDIS_FALLBACK_RETRY_MS = 30_000;
let redisRecoveryTimer = null;

function scheduleRedisRecovery() {
  if (redisRecoveryTimer) return;
  redisRecoveryTimer = setTimeout(() => {
    redisRecoveryTimer = null;
    if (!redisFallback) return;
    initQueue().catch((error) => {
      logger.error('Redis recovery attempt failed', { error: error.message });
    });
  }, REDIS_FALLBACK_RETRY_MS);
  // Never hold the process open just to retry a dependency.
  redisRecoveryTimer.unref?.();
}

export function waitForRedisReady(redis, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timeout);
      redis.removeListener('ready', onReady);
      redis.removeListener('error', onError);
      if (error) {
        redis.disconnect();
        reject(error);
        return;
      }
      resolve();
    };
    const onReady = () => finish();
    const onError = (error) => finish(error);
    const timeout = setTimeout(
      () => finish(new Error(`Redis connection timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    redis.once('ready', onReady);
    redis.once('error', onError);
  });
}

export async function initQueue() {
  if (process.env.REDIS_ENABLED === 'false') {
    redisFallback = false;
    logger.info('Queue initialized in Standalone In-Memory mode (REDIS_ENABLED=false)');
    return { mode: 'memory' };
  }

  let redis;
  try {
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    redis = new IORedis(createRedisOptions());

    await waitForRedisReady(redis);

    bullQueue = new Queue('motion-render', { connection: redis });
    usingRedis = true;
    redisFallback = false;
    logger.info('Queue connected to Redis (BullMQ mode)');
    return { mode: 'redis', queue: bullQueue };
  } catch (e) {
    // waitForRedisReady closes connection failures. Import/setup errors can happen
    // before that helper runs, so close any client still left behind here too.
    redis?.disconnect();
    logger.warn('Redis unavailable, falling back to In-Memory Queue', { reason: e.message });
    usingRedis = false;
    redisFallback = true;
    scheduleRedisRecovery();
    return { mode: 'memory' };
  }
}

export async function enqueueRenderJob(jobPayload) {
  metrics.jobsSubmittedTotal += 1;
  const jobId = `job-${crypto.randomBytes(4).toString('hex')}`;

  if (usingRedis && bullQueue) {
    try {
      const job = await bullQueue.add('motion', { ...jobPayload, jobId }, {
        jobId,
        priority: Number(jobPayload.priority || 5),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
      return { job_id: job.id, mode: 'redis_bullmq', status: 'queued' };
    } catch (error) {
      throw new QueueUnavailableError('Redis queue is unavailable', error);
    }
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

export async function getJobStatusFromStores(
  jobId,
  { memoryJobs = inMemoryJobs, redisQueue = bullQueue, redisActive = usingRedis } = {}
) {
  // Jobs accepted during startup fallback keep running in this process. Redis can recover
  // before they finish, but that must not make their IDs disappear from status polling.
  const memoryJob = memoryJobs.get(jobId);
  if (memoryJob) return memoryJob;

  if (!redisActive || !redisQueue) return null;
  const job = await redisQueue.getJob(jobId);
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

export async function getJobStatus(jobId) {
  return getJobStatusFromStores(jobId);
}

/**
 * Reads BullMQ counters without ever rejecting.
 *
 * These are polled by unauthenticated observability routes, and ioredis rejects
 * in-flight commands the moment its socket drops. A Redis restart would otherwise
 * surface as an unhandled rejection and take the whole API down with it, turning a
 * recoverable dependency blip into a process restart.
 */
const QUEUE_STATS_TIMEOUT_MS = 2000;
let queueStatsAvailable = null;

function unavailableQueueStats(reason) {
  // Health and metrics polling can run many times per minute. Log state transitions, not
  // every poll, so a Redis outage remains visible without flooding production logs.
  if (queueStatsAvailable !== false) {
    logger.warn('Redis queue stats unavailable, reporting degraded counts', { reason });
  }
  queueStatsAvailable = false;
  return {
    mode: 'redis_unavailable',
    available: false,
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
  };
}

export function isQueueHealthy(stats) {
  return stats.available !== false && stats.waiting < 100;
}

export async function getRedisQueueStats(queue, { timeoutMs = QUEUE_STATS_TIMEOUT_MS } = {}) {
  let timeout;
  try {
    // ioredis commandTimeout rejects and removes timed-out commands. The race remains a
    // route-level deadline, while enableOfflineQueue=false prevents health polling from
    // accumulating work during an outage.
    const counts = Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);
    const deadline = new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const [waiting, active, completed, failed] = await Promise.race([counts, deadline]);
    if (queueStatsAvailable === false) {
      logger.info('Redis queue stats available again');
    }
    queueStatsAvailable = true;
    return { mode: 'redis_bullmq', available: true, waiting, active, completed, failed };
  } catch (error) {
    return unavailableQueueStats(error.message);
  } finally {
    clearTimeout(timeout);
  }
}

export function countMemoryQueue(memoryJobs = inMemoryJobs) {
  let waiting = 0, active = 0, completed = 0, failed = 0;
  for (const job of memoryJobs.values()) {
    if (job.status === 'queued') waiting++;
    else if (job.status === 'completed') completed++;
    else if (job.status === 'failed') failed++;
    else active++;
  }
  return { waiting, active, completed, failed };
}

export function combineQueueStats(redisStats, memoryStats, deadLetterCount) {
  const hasMemoryJobs = Object.values(memoryStats).some((count) => count > 0);
  return {
    ...redisStats,
    mode: hasMemoryJobs ? 'redis_bullmq_with_memory' : redisStats.mode,
    waiting: redisStats.waiting + memoryStats.waiting,
    active: redisStats.active + memoryStats.active,
    completed: redisStats.completed + memoryStats.completed,
    failed: redisStats.failed + memoryStats.failed,
    deadLetterCount,
  };
}

export async function getQueueStats() {
  const memoryStats = countMemoryQueue();
  if (usingRedis && bullQueue) {
    const redisStats = await getRedisQueueStats(bullQueue);
    return combineQueueStats(redisStats, memoryStats, deadLetterQueue.length);
  }

  return {
    mode: redisFallback ? 'redis_fallback_memory' : 'in_memory',
    available: !redisFallback,
    ...memoryStats,
    deadLetterCount: deadLetterQueue.length,
  };
}
