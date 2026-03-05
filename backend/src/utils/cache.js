/**
 * Redis cache client with in-memory fallback
 *
 * - If REDIS_URL is set and reachable, uses Redis
 * - Otherwise, falls back to an in-memory Map with TTL tracking
 * - All functions are async, all errors are caught (graceful degradation)
 */

import logger from './logger.js';

// Redis is imported dynamically inside initCache() to avoid crash when package is not installed
let redisModule = null;

// ---------------------------------------------------------------------------
// TTL presets (seconds)
// ---------------------------------------------------------------------------

export const CACHE_TTL = {
  STATS: 30,           // 30 seconds
  GRAPH: 300,          // 5 minutes
  COMPANY_DETAIL: 600, // 10 minutes
  SEARCH: 120,         // 2 minutes
  RATE_LIMIT: 60,      // 1 minute
};

const DEFAULT_TTL = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {import('redis').RedisClientType | null} */
let redisClient = null;
let useRedis = false;

/** @type {Map<string, { value: unknown, expiresAt: number }>} */
const memoryStore = new Map();

// ---------------------------------------------------------------------------
// In-memory helpers
// ---------------------------------------------------------------------------

/**
 * Remove expired entries from the in-memory store.
 * Called lazily on reads and periodically via a background sweep.
 */
function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }
}

// Background sweep every 60 seconds to keep memory bounded
const _pruneInterval = setInterval(pruneExpired, 60_000);
// Allow Node to exit cleanly even if the interval is still active
if (_pruneInterval.unref) _pruneInterval.unref();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the cache layer.
 * Attempts to connect to Redis if REDIS_URL is set.
 * Falls back to in-memory Map on failure or missing URL.
 */
export async function initCache() {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    logger.info('Cache initialized (in-memory fallback, no REDIS_URL set)');
    useRedis = false;
    return;
  }

  try {
    // Dynamic import — avoids crash when redis package is not installed
    try {
      redisModule = await import('redis');
    } catch {
      logger.warn('redis package not installed, falling back to in-memory cache');
      useRedis = false;
      return;
    }

    redisClient = redisModule.createClient({ url: redisUrl });

    redisClient.on('error', (err) => {
      logger.error('Redis client error', { error: err.message });
    });

    redisClient.on('reconnecting', () => {
      logger.warn('Redis reconnecting');
    });

    redisClient.on('ready', () => {
      logger.info('Redis connection ready');
      useRedis = true;
    });

    redisClient.on('end', () => {
      logger.warn('Redis connection closed');
      useRedis = false;
    });

    await redisClient.connect();
    useRedis = true;
    logger.info('Cache initialized (Redis)', { url: redisUrl.replace(/\/\/.*@/, '//<redacted>@') });
  } catch (err) {
    logger.warn('Redis connection failed, falling back to in-memory cache', {
      error: err.message,
    });
    redisClient = null;
    useRedis = false;
  }
}

/**
 * Get a cached value by key.
 * Returns the parsed value or null if not found / expired.
 *
 * @param {string} key
 * @returns {Promise<unknown | null>}
 */
export async function cacheGet(key) {
  try {
    if (useRedis && redisClient) {
      const raw = await redisClient.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }

    // In-memory fallback
    const entry = memoryStore.get(key);
    if (!entry) return null;

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      memoryStore.delete(key);
      return null;
    }

    return entry.value;
  } catch (err) {
    logger.error('cacheGet failed', { key, error: err.message });
    return null;
  }
}

/**
 * Set a cached value.
 *
 * @param {string}  key
 * @param {unknown} value       - Will be JSON-stringified for Redis
 * @param {number}  [ttlSeconds] - Time-to-live in seconds (default 300)
 * @returns {Promise<void>}
 */
export async function cacheSet(key, value, ttlSeconds = DEFAULT_TTL) {
  try {
    if (useRedis && redisClient) {
      const serialized = JSON.stringify(value);
      await redisClient.set(key, serialized, { EX: ttlSeconds });
      return;
    }

    // In-memory fallback
    memoryStore.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  } catch (err) {
    logger.error('cacheSet failed', { key, error: err.message });
  }
}

/**
 * Delete a single cached key.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function cacheDel(key) {
  try {
    if (useRedis && redisClient) {
      await redisClient.del(key);
      return;
    }

    memoryStore.delete(key);
  } catch (err) {
    logger.error('cacheDel failed', { key, error: err.message });
  }
}

/**
 * Delete all keys matching a glob-style pattern (e.g. 'stats:*').
 *
 * @param {string} pattern - Glob pattern (supports * as wildcard)
 * @returns {Promise<number>} Number of keys deleted
 */
export async function cacheFlush(pattern) {
  try {
    if (useRedis && redisClient) {
      let deleted = 0;
      for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        await redisClient.del(key);
        deleted++;
      }
      logger.info('cacheFlush (Redis)', { pattern, deleted });
      return deleted;
    }

    // In-memory fallback: convert glob pattern to RegExp
    const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    const regex = new RegExp(regexStr);
    let deleted = 0;

    for (const key of memoryStore.keys()) {
      if (regex.test(key)) {
        memoryStore.delete(key);
        deleted++;
      }
    }

    logger.info('cacheFlush (memory)', { pattern, deleted });
    return deleted;
  } catch (err) {
    logger.error('cacheFlush failed', { pattern, error: err.message });
    return 0;
  }
}

/**
 * Return diagnostic info about the cache.
 *
 * @returns {Promise<{ type: 'redis' | 'memory', connected: boolean, keys: number }>}
 */
export async function getCacheStats() {
  try {
    if (useRedis && redisClient) {
      const info = await redisClient.dbSize();
      return { type: 'redis', connected: true, keys: info };
    }

    // Prune first so the count is accurate
    pruneExpired();
    return { type: 'memory', connected: true, keys: memoryStore.size };
  } catch (err) {
    logger.error('getCacheStats failed', { error: err.message });
    return { type: useRedis ? 'redis' : 'memory', connected: false, keys: 0 };
  }
}
