/**
 * Multi-tenant context middleware.
 * Extracts and validates tenant from JWT or header, attaches to req.tenant.
 */

import { supabase } from '../database/supabase.js';
import { logger } from '../utils/logger.js';

/** @type {Map<string, {tenant: Object, cachedAt: number}>} */
const tenantCache = new Map();
const TENANT_CACHE_TTL = 300_000; // 5 minutes

/**
 * Middleware factory: extract and validate tenant context from request.
 * Sets req.tenant with tenant info for downstream handlers.
 *
 * Tenant resolution order:
 *   1. req.user.tenant_id (from JWT/auth middleware)
 *   2. X-Tenant-Id header (for API key auth)
 *   3. Falls back to default single-tenant mode
 */
export function tenantContext() {
  return async (req, res, next) => {
    try {
      const tenantId = req.user?.tenant_id || req.headers['x-tenant-id'];

      if (tenantId) {
        // Check cache first
        const now = Date.now();
        const cached = tenantCache.get(tenantId);
        if (cached && (now - cached.cachedAt) < TENANT_CACHE_TTL) {
          req.tenant = cached.tenant;
          return next();
        }

        const { data: tenant, error } = await supabase
          .from('tenants')
          .select('id, name, slug, settings, is_active')
          .eq('id', tenantId)
          .eq('is_active', true)
          .single();

        if (error || !tenant) {
          logger.warn('tenant_invalid', { tenantId, error: error?.message });
          return res.status(403).json({ success: false, error: 'Invalid or inactive tenant' });
        }

        tenantCache.set(tenantId, { tenant, cachedAt: now });
        req.tenant = tenant;
      } else {
        // Single-tenant mode: use default tenant
        req.tenant = { id: null, name: 'default', slug: 'default', settings: {} };
      }

      next();
    } catch (err) {
      logger.error('tenant_error', { error: err.message });
      // Fail open: set default tenant to avoid blocking operations
      req.tenant = { id: null, name: 'default', slug: 'default', settings: {} };
      next();
    }
  };
}

/**
 * Middleware: require an explicit tenant context (fail if no tenant resolved).
 * Use this on endpoints that must operate within a specific tenant scope.
 */
export function requireTenant() {
  return (req, res, next) => {
    if (!req.tenant || !req.tenant.id) {
      return res.status(403).json({ success: false, error: 'Tenant context required' });
    }
    next();
  };
}
