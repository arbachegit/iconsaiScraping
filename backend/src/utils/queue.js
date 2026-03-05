/**
 * BullMQ job queue wrapper
 * Gracefully degrades to no-ops when Redis is unavailable
 */

import logger from './logger.js';

// BullMQ is imported dynamically to avoid crash when package is not installed
let BullQueue = null;
let BullWorker = null;

export const QUEUE_NAMES = {
  ENRICHMENT: 'enrichment',
  GRAPH_DETECTION: 'graph-detection',
  EMBEDDING_GENERATION: 'embedding-generation',
  NEWS_COLLECTION: 'news-collection',
};

const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
};

/** @type {Map<string, Queue>} */
const queues = new Map();

/** @type {Worker[]} */
const workers = [];

/**
 * Parse REDIS_URL into a BullMQ-compatible connection object.
 * Returns null when the env var is missing.
 */
function getConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      ...(parsed.password && { password: parsed.password }),
    };
  } catch (err) {
    logger.error('Failed to parse REDIS_URL', { error: err });
    return null;
  }
}

let connection = null;
let bullmqAvailable = false;

/**
 * Initialize BullMQ (dynamic import to avoid crash when package is not installed).
 */
async function initBullMQ() {
  connection = getConnection();
  if (!connection) {
    logger.warn('REDIS_URL not set — job queues disabled (no-op mode)');
    return;
  }
  try {
    const bullmq = await import('bullmq');
    BullQueue = bullmq.Queue;
    BullWorker = bullmq.Worker;
    bullmqAvailable = true;
    logger.info('BullMQ loaded successfully');
  } catch {
    logger.warn('bullmq package not installed — job queues disabled (no-op mode)');
    connection = null;
  }
}

// Kick off lazy init (non-blocking)
const _initPromise = initBullMQ();

/**
 * Create (or retrieve) a BullMQ Queue by name.
 * @param {string} queueName
 * @returns {Queue | null}
 */
export function initQueue(queueName) {
  if (!connection || !BullQueue) return null;
  if (queues.has(queueName)) return queues.get(queueName);

  const queue = new BullQueue(queueName, { connection });
  queues.set(queueName, queue);
  logger.info('Queue initialised', { queue: queueName });
  return queue;
}

/**
 * Add a job to a named queue.
 * @param {string} queueName
 * @param {string} jobName
 * @param {object} data
 * @param {object} [opts]
 */
export async function addJob(queueName, jobName, data, opts = {}) {
  const queue = initQueue(queueName);
  if (!queue) return null;

  const job = await queue.add(jobName, data, { ...DEFAULT_JOB_OPTS, ...opts });
  logger.info('Job added', { queue: queueName, job: jobName, jobId: job.id });
  return job;
}

/**
 * Create a Worker that processes jobs from a queue.
 * @param {string} queueName
 * @param {Function} processor  — async (job) => result
 * @param {object}  [opts]
 * @returns {Worker | null}
 */
export function createWorker(queueName, processor, opts = {}) {
  if (!connection || !BullWorker) return null;

  const worker = new BullWorker(queueName, processor, { connection, ...opts });

  worker.on('completed', (job) => {
    logger.info('Job completed', { queue: queueName, jobId: job.id });
  });
  worker.on('failed', (job, err) => {
    logger.error('Job failed', { queue: queueName, jobId: job?.id, error: err });
  });

  workers.push(worker);
  logger.info('Worker created', { queue: queueName });
  return worker;
}

/**
 * Get job counts for a named queue.
 * @param {string} queueName
 */
export async function getQueueStats(queueName) {
  const queue = initQueue(queueName);
  if (!queue) return { waiting: 0, active: 0, completed: 0, failed: 0 };
  return queue.getJobCounts('waiting', 'active', 'completed', 'failed');
}

/**
 * Gracefully close all queues and workers.
 */
export async function closeAllQueues() {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([...queues.values()].map((q) => q.close()));
  workers.length = 0;
  queues.clear();
  logger.info('All queues and workers closed');
}

export default {
  initQueue,
  addJob,
  createWorker,
  getQueueStats,
  closeAllQueues,
  QUEUE_NAMES,
};
