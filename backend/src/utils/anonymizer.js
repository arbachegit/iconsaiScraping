/**
 * Data anonymization utilities for LGPD compliance.
 * Uses Node.js built-in crypto for hashing (no external deps).
 */

import { createHash } from 'node:crypto';
import logger from './logger.js';

/**
 * Mask CPF: 123.456.789-00 → 123.***.***-00
 * @param {string} cpf - CPF string (formatted or raw digits)
 * @returns {string} Masked CPF
 */
export function maskCpf(cpf) {
  if (!cpf) return cpf;
  const digits = String(cpf).replace(/\D/g, '');
  if (digits.length !== 11) return '[INVALID_CPF]';
  return `${digits.slice(0, 3)}.***.***-${digits.slice(9, 11)}`;
}

/**
 * Mask email: user@domain.com → u***@domain.com
 * @param {string} email - Email address
 * @returns {string} Masked email
 */
export function maskEmail(email) {
  if (!email) return email;
  const str = String(email);
  const atIndex = str.indexOf('@');
  if (atIndex < 1) return '[INVALID_EMAIL]';
  const local = str.slice(0, atIndex);
  const domain = str.slice(atIndex);
  return `${local[0]}${'*'.repeat(Math.max(local.length - 1, 2))}${domain}`;
}

/**
 * Mask phone: (11) 99999-1234 → (11) ****-1234
 * @param {string} phone - Phone number (any format)
 * @returns {string} Masked phone
 */
export function maskPhone(phone) {
  if (!phone) return phone;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 8) return '[INVALID_PHONE]';
  // Keep area code (first 2 digits) and last 4 digits visible
  const areaCode = digits.length >= 10 ? digits.slice(0, 2) : '';
  const lastFour = digits.slice(-4);
  const maskedMiddle = '****';
  if (areaCode) {
    return `(${areaCode}) ${maskedMiddle}-${lastFour}`;
  }
  return `${maskedMiddle}-${lastFour}`;
}

/**
 * Hash a value with SHA-256 (one-way, deterministic)
 * @param {string} value - Value to hash
 * @returns {string} SHA-256 hex digest
 */
export function hashValue(value) {
  if (value == null) return null;
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Redact: replace entire value with '[REDACTED]'
 * @param {*} value - Any value
 * @returns {string} '[REDACTED]'
 */
export function redact(value) {
  if (value == null) return null;
  return '[REDACTED]';
}

/** Map of rule names to anonymization functions */
const RULE_MAP = {
  mask_cpf: maskCpf,
  mask_email: maskEmail,
  mask_phone: maskPhone,
  hash: hashValue,
  redact,
  none: (v) => v,
};

/**
 * Apply a named anonymization rule to a value.
 * @param {string} value - Original value
 * @param {string} rule - One of: 'mask_cpf', 'mask_email', 'mask_phone', 'hash', 'redact', 'none'
 * @returns {string} Anonymized value
 */
export function anonymize(value, rule) {
  if (value == null) return value;
  const fn = RULE_MAP[rule];
  if (!fn) {
    logger.warn('Unknown anonymization rule, falling back to redact', { rule });
    return redact(value);
  }
  return fn(value);
}

/**
 * Anonymize an object based on column classification rules.
 * Fields not listed in classifications are passed through unchanged.
 * @param {Object} data - Raw data object
 * @param {Array<{column_name: string, anonymization_rule: string}>} classifications - Rules per column
 * @returns {Object} New object with anonymized fields
 */
export function anonymizeRecord(data, classifications) {
  if (!data || typeof data !== 'object') return data;
  if (!Array.isArray(classifications) || classifications.length === 0) return { ...data };

  const rulesByColumn = new Map();
  for (const { column_name, anonymization_rule } of classifications) {
    rulesByColumn.set(column_name, anonymization_rule);
  }

  const result = {};
  for (const [key, value] of Object.entries(data)) {
    const rule = rulesByColumn.get(key);
    result[key] = rule ? anonymize(value, rule) : value;
  }

  return result;
}
