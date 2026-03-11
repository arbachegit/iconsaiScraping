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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate and return a trimmed UUID, or null if invalid.
 *
 * @param {string} str - Raw input
 * @returns {string | null} Valid UUID or null
 */
export function sanitizeUUID(str) {
  if (!str) return null;
  const trimmed = str.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

/**
 * Remove newlines and control characters to prevent log injection.
 *
 * @param {string} str - Raw input
 * @returns {string} Safe string for logging
 */
export function sanitizeForLog(str) {
  if (!str) return '';
  return String(str).replace(/[\r\n\t\x00-\x1f]/g, ' ').trim();
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
