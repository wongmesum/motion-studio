import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  combineQueueStats,
  countMemoryQueue,
  createRedisOptions,
  getJobStatusFromStores,
  getQueueStats,
  getRedisQueueStats,
  initQueue,
  isQueueHealthy,
  QueueUnavailableError,
  waitForRedisReady,
} from '../vps-server/queue.js';
import { createJobStatusHandler, createRenderHandler } from '../vps-server/server.js';

test('Redis reconnect delay is bounded instead of disabling reconnects', () => {
  const options = createRedisOptions({
    REDIS_HOST: 'redis',
    REDIS_PORT: '6380',
    REDIS_PASSWORD: 'secret',
  });

  assert.equal(options.host, 'redis');
  assert.equal(options.port, 6380);
  assert.equal(options.password, 'secret');
  assert.equal(options.maxRetriesPerRequest, 1);
  assert.equal(options.commandTimeout, 5000);
  assert.equal(options.enableOfflineQueue, false);
  assert.equal(options.autoResendUnfulfilledCommands, false);
  assert.equal(options.retryStrategy(1), 200);
  assert.equal(options.retryStrategy(3), 800);
  assert.equal(options.retryStrategy(20), 10_000);
});

test('queue stats report Redis disconnects without rejecting', async () => {
  const connectionError = new Error('Connection is closed.');
  const queue = {
    getWaitingCount: async () => {
      throw connectionError;
    },
    getActiveCount: async () => 0,
    getCompletedCount: async () => 0,
    getFailedCount: async () => 0,
  };

  const stats = await getRedisQueueStats(queue);

  assert.deepEqual(stats, {
    mode: 'redis_unavailable',
    available: false,
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
  });
});

test('health degrades when Redis queue stats are unavailable', () => {
  assert.equal(isQueueHealthy({ available: false, waiting: 0 }), false);
  assert.equal(isQueueHealthy({ available: true, waiting: 99 }), true);
  assert.equal(isQueueHealthy({ available: true, waiting: 100 }), false);
  // In-memory mode has no `available` field and remains healthy under its threshold.
  assert.equal(isQueueHealthy({ mode: 'in_memory', waiting: 0 }), true);
});

test('queue stats read independent Redis counters in parallel', async () => {
  const calls = [];
  const makeCounter = (name, value) => async () => {
    calls.push(name);
    return value;
  };
  const queue = {
    getWaitingCount: makeCounter('waiting', 2),
    getActiveCount: makeCounter('active', 1),
    getCompletedCount: makeCounter('completed', 7),
    getFailedCount: makeCounter('failed', 3),
  };

  const stats = await getRedisQueueStats(queue);

  assert.deepEqual(new Set(calls), new Set(['waiting', 'active', 'completed', 'failed']));
  assert.deepEqual(stats, {
    mode: 'redis_bullmq',
    available: true,
    waiting: 2,
    active: 1,
    completed: 7,
    failed: 3,
  });
});

test('queue stats time out when Redis never settles', async () => {
  const never = () => new Promise(() => {});
  const queue = {
    getWaitingCount: never,
    getActiveCount: never,
    getCompletedCount: never,
    getFailedCount: never,
  };

  const startedAt = Date.now();
  const stats = await getRedisQueueStats(queue, { timeoutMs: 20 });

  assert.equal(stats.mode, 'redis_unavailable');
  assert.equal(stats.available, false);
  assert.ok(Date.now() - startedAt < 500, 'health probes must not hang for a dead Redis socket');
});

test('health reports degraded when Redis was configured but unreachable at startup', async () => {
  const previousPort = process.env.REDIS_PORT;
  const previousEnabled = process.env.REDIS_ENABLED;
  const previousHost = process.env.REDIS_HOST;
  // Port 1 refuses immediately, so the fallback is exercised without a real Redis.
  process.env.REDIS_HOST = '127.0.0.1';
  process.env.REDIS_PORT = '1';
  delete process.env.REDIS_ENABLED;

  try {
    const result = await initQueue();
    assert.equal(result.mode, 'memory', 'an unreachable Redis must fall back to memory');

    const stats = await getQueueStats();
    assert.equal(stats.available, false, 'silent fallback must be visible to health checks');
    assert.equal(isQueueHealthy(stats), false, 'a stack without its queue must not report healthy');
  } finally {
    if (previousPort === undefined) delete process.env.REDIS_PORT;
    else process.env.REDIS_PORT = previousPort;
    if (previousHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = previousHost;
    if (previousEnabled === undefined) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = previousEnabled;
  }
});

test('an initial Redis failure closes the unused reconnecting client', async () => {
  let disconnected = false;
  const client = {
    once(event, callback) {
      if (event === 'error') queueMicrotask(() => callback(new Error('ECONNREFUSED')));
      return this;
    },
    removeListener() {
      return this;
    },
    disconnect() {
      disconnected = true;
    },
  };

  await assert.rejects(waitForRedisReady(client, { timeoutMs: 100 }), /ECONNREFUSED/);
  assert.equal(disconnected, true, 'a failed startup client must not retry forever in the background');
});

test('the restart watchdog probes liveness, not Redis-dependent readiness', () => {
  // `/health` returns 503 while Redis is unreachable. Restarting the app cannot restore
  // Redis, so watching it would restart the container every cycle and drop in-memory jobs.
  const script = fs.readFileSync(
    new URL('../scripts/health-check.sh', import.meta.url),
    'utf8'
  );

  assert.match(script, /"\$BASE\/live"/, 'the watchdog must poll the liveness route');
  assert.doesNotMatch(script, /"\$BASE\/health"/, 'readiness must not drive restarts');
});

test('a render submission reports a queue outage as 503, not a bad request', async () => {
  const handler = createRenderHandler(async () => {
    throw new QueueUnavailableError('Redis queue is unavailable', new Error('Connection is closed.'));
  });
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  await handler({ body: { html: '<html></html>' } }, response);

  assert.equal(response.statusCode, 503, 'a dependency outage must be retryable');
  assert.deepEqual(response.payload, { error: 'Layanan antrean sedang tidak tersedia' });
});

test('a rejected render payload still reports 400', async () => {
  const handler = createRenderHandler(async () => {
    throw new Error('Duration must be between 1s and 60s');
  });
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  await handler({ body: { html: '<html></html>', duration: 9999 } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, 'Duration must be between 1s and 60s');
});

test('job status returns 503 when Redis rejects instead of leaking an async rejection', async () => {
  const handler = createJobStatusHandler(async () => {
    throw new Error('Connection is closed.');
  });
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  await handler({ params: { id: 'job-dead-redis' } }, response);

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.payload, { error: 'Layanan antrean sedang tidak tersedia' });
});

test('fallback jobs stay queryable after Redis recovers', async () => {
  const memoryRecord = {
    job_id: 'job-memory',
    status: 'processing',
    progress: 40,
  };
  let redisRead = false;
  const redisQueue = {
    async getJob() {
      redisRead = true;
      return null;
    },
  };

  const status = await getJobStatusFromStores('job-memory', {
    memoryJobs: new Map([['job-memory', memoryRecord]]),
    redisQueue,
    redisActive: true,
  });

  assert.equal(status, memoryRecord);
  assert.equal(redisRead, false, 'memory-origin jobs must not disappear behind Redis lookup');
});

test('queue stats retain fallback jobs and dead letters after Redis recovers', () => {
  const memoryStats = countMemoryQueue(new Map([
    ['waiting', { status: 'queued' }],
    ['active', { status: 'processing' }],
    ['failed', { status: 'failed' }],
  ]));
  const combined = combineQueueStats({
    mode: 'redis_bullmq',
    available: true,
    waiting: 2,
    active: 3,
    completed: 5,
    failed: 7,
  }, memoryStats, 1);

  assert.deepEqual(combined, {
    mode: 'redis_bullmq_with_memory',
    available: true,
    waiting: 3,
    active: 4,
    completed: 5,
    failed: 8,
    deadLetterCount: 1,
  });
});
