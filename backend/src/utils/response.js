/**
 * Standardized response helpers for Express routes.
 *
 * Envelope: { success: boolean, data?: any, error?: string, meta?: object }
 *
 * Usage:
 *   import { sendSuccess, sendError } from '../utils/response.js';
 *   sendSuccess(res, { companies: data }, { count, offset, limit });
 *   sendError(res, 500, 'Internal error');
 */

/**
 * Send a standardised success response.
 * @param {import('express').Response} res
 * @param {object} data  - Payload (spread into the envelope alongside `success: true`)
 * @param {object} [meta] - Optional metadata (count, offset, limit, etc.)
 */
export function sendSuccess(res, data = {}, meta) {
  const body = { success: true, ...data };
  if (meta) body.meta = meta;
  return res.json(body);
}

/**
 * Send a standardised error response.
 * @param {import('express').Response} res
 * @param {number} status - HTTP status code
 * @param {string} message - Human-readable error message
 */
export function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    error: message,
  });
}
