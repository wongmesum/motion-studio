import os from 'os';

/**
 * Structured Logger & Prometheus Metrics Collector
 */
export const metrics = {
  jobsSubmittedTotal: 0,
  jobsCompletedTotal: 0,
  jobsFailedTotal: 0,
  cacheHitsTotal: 0,
  deepseekFixesTotal: 0,
  ffmpegFailuresTotal: 0,
  lastRenderDurationSeconds: 0,
  renderDurations: [],
};

export function recordRenderDuration(sec) {
  metrics.lastRenderDurationSeconds = sec;
  metrics.renderDurations.push(sec);
  if (metrics.renderDurations.length > 100) {
    metrics.renderDurations.shift();
  }
}

export function formatPrometheusMetrics(queueDepth = 0) {
  const sorted = [...metrics.renderDurations].sort((a, b) => a - b);
  const p99 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] : 0;
  const cpuLoad = os.loadavg()[0] || 0;
  const freeMemMb = Math.round(os.freemem() / 1024 / 1024);

  return [
    '# HELP render_duration_seconds Last render job duration in seconds',
    '# TYPE render_duration_seconds gauge',
    `render_duration_seconds ${metrics.lastRenderDurationSeconds}`,
    '# HELP frame_render_p99 P99 render duration in seconds',
    '# TYPE frame_render_p99 gauge',
    `frame_render_p99 ${p99}`,
    '# HELP queue_depth Current number of waiting jobs in queue',
    '# TYPE queue_depth gauge',
    `queue_depth ${queueDepth}`,
    '# HELP jobs_submitted_total Total render jobs submitted',
    '# TYPE jobs_submitted_total counter',
    `jobs_submitted_total ${metrics.jobsSubmittedTotal}`,
    '# HELP jobs_completed_total Total render jobs completed',
    '# TYPE jobs_completed_total counter',
    `jobs_completed_total ${metrics.jobsCompletedTotal}`,
    '# HELP jobs_failed_total Total render jobs failed',
    '# TYPE jobs_failed_total counter',
    `jobs_failed_total ${metrics.jobsFailedTotal}`,
    '# HELP cache_hits_total Total content-addressable cache hits',
    '# TYPE cache_hits_total counter',
    `cache_hits_total ${metrics.cacheHitsTotal}`,
    '# HELP deepseek_fixes_total Total auto-fixes performed by DeepSeek Engineer',
    '# TYPE deepseek_fixes_total counter',
    `deepseek_fixes_total ${metrics.deepseekFixesTotal}`,
    '# HELP ffmpeg_failures_total Total FFmpeg encoding failures',
    '# TYPE ffmpeg_failures_total counter',
    `ffmpeg_failures_total ${metrics.ffmpegFailuresTotal}`,
    '# HELP system_cpu_load_1m System 1-minute load average',
    '# TYPE system_cpu_load_1m gauge',
    `system_cpu_load_1m ${cpuLoad.toFixed(2)}`,
    '# HELP system_free_memory_mb Free system memory in MB',
    '# TYPE system_free_memory_mb gauge',
    `system_free_memory_mb ${freeMemMb}`,
  ].join('\n');
}

function log(level, msg, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  console.log(JSON.stringify(entry));
}

export const logger = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),
};
