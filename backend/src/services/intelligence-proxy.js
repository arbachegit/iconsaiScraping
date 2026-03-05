/**
 * Intelligence Proxy Service
 * Proxies requests from Node.js backend to Python intelligence API.
 *
 * The intelligence module runs in the Python FastAPI service.
 * This proxy forwards requests from the Node.js Express backend.
 */

import logger from '../utils/logger.js';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://api:8000';

/**
 * Proxy a request to the Python intelligence API.
 *
 * @param {string} path - API path (e.g. "/api/intelligence/query")
 * @param {Object} body - Request body
 * @param {string} [method='POST'] - HTTP method
 * @returns {Promise<Object>} Response data
 */
export async function proxyToIntelligence(path, body = null, method = 'POST') {
  const url = `${PYTHON_API_URL}${path}`;

  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const startTime = Date.now();
    const response = await fetch(url, options);
    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('intelligence_proxy_error', {
        url,
        status: response.status,
        body: errorBody.substring(0, 500),
        durationMs,
      });
      return {
        success: false,
        error: `Intelligence API returned ${response.status}`,
        details: errorBody.substring(0, 200),
      };
    }

    const data = await response.json();
    logger.info('intelligence_proxy_success', { path, durationMs });
    return data;
  } catch (err) {
    logger.error('intelligence_proxy_exception', { url, error: err.message });
    return {
      success: false,
      error: 'Intelligence API unavailable',
      details: err.message,
    };
  }
}
