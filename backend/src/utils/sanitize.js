/**
 * Sanitization utilities for SQL and PII safety
 *
 * escapeLike  — escapes %, _ and \ so they are treated as literals inside ILIKE patterns
 * maskPII     — masks names/PII for safe logging (e.g. "Fernando Arbache" → "Fer***che")
 */

/**
 * Escape ILIKE special characters (%, _, \) so user/LLM input
 * is treated as literal text inside Supabase `.ilike()` / `.or()` patterns.
 *
 * @param {string} str - Raw input string
 * @returns {string} Escaped string safe for ILIKE interpolation
 */
export function escapeLike(str) {
  if (!str) return '';
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Mask PII (names, emails, etc.) for structured logging.
 * Shows first 3 and last 3 characters, masks the rest.
 *
 * @param {string} str - PII string to mask
 * @returns {string} Masked string (e.g. "Fer***che")
 */
export function maskPII(str) {
  if (!str || str.length <= 3) return '***';
  return str.slice(0, 3) + '***' + str.slice(-3);
}
