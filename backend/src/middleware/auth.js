import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';
import { ALL_PERMISSIONS } from '../constants.js';

const JWT_SECRET = process.env.JWT_SECRET_KEY;
const JWT_ALGORITHM = process.env.JWT_ALGORITHM || 'HS256';

/**
 * Express middleware that validates JWT tokens issued by the Python auth service.
 * Attaches decoded user data to req.user.
 * Returns 401 if token is missing/invalid.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Authorization header with Bearer token is required'
    });
  }

  if (!JWT_SECRET) {
    logger.error('JWT_SECRET_KEY not configured');
    return res.status(500).json({
      success: false,
      error: 'Authentication not configured'
    });
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });

    if (payload.type !== 'access') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token type'
      });
    }

    req.user = {
      email: payload.sub,
      user_id: payload.user_id,
      name: payload.name,
      is_admin: payload.is_admin || false,
      permissions: payload.permissions || []
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }
    logger.warn('JWT verification failed', { error: err.message });
    return res.status(401).json({
      success: false,
      error: 'Invalid token'
    });
  }
}

/**
 * Middleware factory that checks if the authenticated user has a specific permission.
 * Must be used AFTER requireAuth so that req.user is populated.
 * Returns 403 if the user does not have the required permission.
 */
export function requirePermission(permission) {
  if (!ALL_PERMISSIONS.includes(permission)) {
    throw new Error(`Invalid permission: ${permission}. Valid: ${ALL_PERMISSIONS.join(', ')}`);
  }

  return (req, res, next) => {
    const userPermissions = req.user?.permissions || [];

    if (!userPermissions.includes(permission)) {
      logger.warn('Permission denied', {
        user: req.user?.email,
        required: permission,
        has: userPermissions,
      });
      return res.status(403).json({
        success: false,
        error: `Permission '${permission}' required`,
      });
    }

    next();
  };
}

