import logger from '../utils/logger.js';
import { cacheGet, cacheSet, CACHE_TTL } from '../utils/cache.js';

export const RATE_LIMITS = {
  superadmin: 1000,
  admin: 500,
  user: 100,
  default: 60,
};

export function rateLimitByUser(options = {}) {
  const {
    windowMs = 60_000,
    maxByRole = RATE_LIMITS,
    keyPrefix = 'ratelimit',
  } = options;

  const windowSec = Math.ceil(windowMs / 1000);

  return async (req, res, next) => {
    try {
      const identity = req.user?.user_id || req.ip;
      const role = req.user?.role || 'default';
      const limit = maxByRole[role] ?? maxByRole.default;
      const endpoint = req.baseUrl + req.path;
      const key = `${keyPrefix}:${identity}:${endpoint}`;
      const now = Date.now();

      const stored = await cacheGet(key);
      let bucket = stored ? JSON.parse(stored) : null;

      if (!bucket || now - bucket.windowStart >= windowMs) {
        bucket = { count: 0, windowStart: now };
      }

      bucket.count += 1;
      await cacheSet(key, JSON.stringify(bucket), windowSec);

      const remaining = Math.max(0, limit - bucket.count);
      const resetAt = Math.ceil((bucket.windowStart + windowMs) / 1000);

      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(resetAt));

      if (bucket.count > limit) {
        const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
        logger.warn('Rate limit exceeded', { identity, role, endpoint, count: bucket.count, limit });
        return res.status(429).json({ error: 'Too many requests', retryAfter });
      }

      next();
    } catch (err) {
      logger.error('Rate limiter error, allowing request', { error: err });
      next();
    }
  };
}
