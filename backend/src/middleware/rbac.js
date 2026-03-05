/**
 * Granular RBAC permission check middleware.
 * Loads role-permission mappings from Supabase and caches in memory.
 */

import { supabase } from '../database/supabase.js';
import { logger } from '../utils/logger.js';

/** @type {Record<string, Array<{module: string, action: string}>> | null} */
let permissionsCache = null;
let permissionsCacheTime = 0;
const PERMISSIONS_CACHE_TTL = 300_000; // 5 minutes

/**
 * Load role-permission mappings from rbac_role_permissions + rbac_permissions.
 * Returns an object keyed by role name, with arrays of {module, action}.
 * @returns {Promise<Record<string, Array<{module: string, action: string}>>>}
 */
async function loadPermissions() {
  const now = Date.now();
  if (permissionsCache && (now - permissionsCacheTime) < PERMISSIONS_CACHE_TTL) {
    return permissionsCache;
  }

  const { data, error } = await supabase
    .from('rbac_role_permissions')
    .select('role, rbac_permissions(module, action)');

  if (error) {
    logger.error('Failed to load RBAC permissions', { error: error.message });
    // Return stale cache if available, otherwise empty
    return permissionsCache || {};
  }

  const mapping = {};
  for (const row of data || []) {
    if (!mapping[row.role]) mapping[row.role] = [];
    const perm = row.rbac_permissions;
    if (perm) {
      mapping[row.role].push({ module: perm.module, action: perm.action });
    }
  }

  permissionsCache = mapping;
  permissionsCacheTime = now;
  logger.debug('RBAC permissions cache refreshed', { roles: Object.keys(mapping).length });

  return mapping;
}

/**
 * Middleware factory: check if the authenticated user's role has a specific module+action permission.
 * Must be used AFTER requireAuth so that req.user is populated.
 * Superadmin role bypasses all checks.
 * @param {string} module - Permission module (e.g. 'companies', 'users')
 * @param {string} action - Permission action (e.g. 'read', 'write', 'delete')
 */
export function checkPermission(module, action) {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const role = user.role || 'user';

      // Superadmin bypasses all checks
      if (role === 'superadmin') return next();

      const permissions = await loadPermissions();
      const rolePerms = permissions[role] || [];

      const hasAccess = rolePerms.some(p => p.module === module && p.action === action);

      if (!hasAccess) {
        logger.warn('rbac_denied', { userId: user.user_id, role, module, action });
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions',
          required: { module, action },
        });
      }

      next();
    } catch (err) {
      logger.error('rbac_error', { error: err.message });
      // Fail open: allow access if RBAC check fails to avoid blocking operations
      next();
    }
  };
}

/**
 * Middleware factory: check if the user has ANY of the specified permissions.
 * Useful for endpoints accessible by multiple permission combinations.
 * @param {Array<{module: string, action: string}>} permissions - Array of {module, action}
 */
export function checkAnyPermission(permissions) {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const role = user.role || 'user';

      if (role === 'superadmin') return next();

      const rolePermissions = await loadPermissions();
      const rolePerms = rolePermissions[role] || [];

      const hasAny = permissions.some(required =>
        rolePerms.some(p => p.module === required.module && p.action === required.action)
      );

      if (!hasAny) {
        logger.warn('rbac_denied_any', { userId: user.user_id, role, required: permissions });
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions',
          required: permissions,
        });
      }

      next();
    } catch (err) {
      logger.error('rbac_error', { error: err.message });
      next();
    }
  };
}
