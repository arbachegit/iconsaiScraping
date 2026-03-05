/**
 * SSE (Server-Sent Events) Streaming Service
 * Provides progressive search results in 7 stages.
 *
 * Stages:
 * 1. db_results (10-50ms) - Trigram + full-text
 * 2. vector_results (100-200ms) - Semantic similarity
 * 3. graph_results (200-300ms) - Relationship-based
 * 4. external_search (500-2000ms) - Serper/Perplexity
 * 5. enrichment (1000-3000ms) - BrasilAPI/Apollo
 * 6. sis_scores (200-500ms) - Strategic Impact Score
 * 7. complete - Final merged results
 */

import logger from '../utils/logger.js';
import { textSearch, vectorSearch, relationalSearch, calculateSIS } from './hybrid-search.js';

/**
 * Initialize SSE connection.
 * Sets headers and returns a send function.
 *
 * @param {Object} res - Express response object
 * @returns {Object} { send, complete, error }
 */
export function initSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Disable nginx buffering
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  return {
    /**
     * Send a stage event.
     * @param {string} stage - Stage name
     * @param {Object} data - Stage data
     */
    send(stage, data) {
      const payload = {
        stage,
        timestamp: new Date().toISOString(),
        ...data
      };
      res.write(`event: ${stage}\ndata: ${JSON.stringify(payload)}\n\n`);
    },

    /**
     * Send completion event and end stream.
     * @param {Object} data - Final merged data
     */
    complete(data) {
      const payload = {
        stage: 'complete',
        timestamp: new Date().toISOString(),
        ...data
      };
      res.write(`event: complete\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    },

    /**
     * Send error event and end stream.
     * @param {string} message - Error message
     */
    error(message) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  };
}

/**
 * Execute streaming search pipeline.
 * Runs all stages progressively, sending results as they become available.
 *
 * @param {Object} res - Express response object
 * @param {Object} params
 * @param {string} params.query - Search query
 * @param {Object} [params.filters={}] - Filters
 * @param {number} [params.limit=50] - Max results per stage
 */
export async function executeStreamingSearch(res, { query, filters = {}, limit = 50 }) {
  const sse = initSSE(res);
  const allResults = new Map(); // id -> merged result
  const timing = {};

  try {
    // Stage 1: Database text search (fastest)
    const startText = Date.now();
    const textResults = await textSearch(query, filters, limit);
    timing.db_ms = Date.now() - startText;

    for (const r of textResults) {
      allResults.set(r.id, { ...r, sources: ['text'] });
    }

    sse.send('db_results', {
      count: textResults.length,
      results: textResults.slice(0, 10), // Send top 10 preview
      durationMs: timing.db_ms
    });

    // Stage 2: Vector search (if available)
    const startVector = Date.now();
    const vectorResults = await vectorSearch(null, limit); // No embedding yet in stream mode
    timing.vector_ms = Date.now() - startVector;

    sse.send('vector_results', {
      count: vectorResults.length,
      available: vectorResults.length > 0,
      durationMs: timing.vector_ms
    });

    // Stage 3: Graph-based search
    const startGraph = Date.now();
    const graphResults = await relationalSearch(query, limit);
    timing.graph_ms = Date.now() - startGraph;

    for (const r of graphResults) {
      if (allResults.has(r.id)) {
        const existing = allResults.get(r.id);
        existing.sources.push('relational');
        existing.relational_score = r.relational_score;
        existing.connected_via = r.connected_via;
      } else {
        allResults.set(r.id, { ...r, sources: ['relational'] });
      }
    }

    sse.send('graph_results', {
      count: graphResults.length,
      results: graphResults.slice(0, 5),
      durationMs: timing.graph_ms
    });

    // Stage 4: External search (placeholder - actual implementation calls serper/perplexity)
    sse.send('external_search', {
      count: 0,
      status: 'skipped_in_stream_mode',
      durationMs: 0
    });

    // Stage 5: Enrichment (placeholder)
    sse.send('enrichment', {
      count: 0,
      status: 'available_on_demand',
      durationMs: 0
    });

    // Stage 6: SIS scores for top results
    const startSIS = Date.now();
    const topIds = [...allResults.keys()].slice(0, 10);
    const sisResults = [];

    for (const id of topIds) {
      const sis = await calculateSIS(id, query);
      if (sis) {
        sisResults.push({ empresa_id: id, ...sis });
        const existing = allResults.get(id);
        if (existing) {
          existing.sis_score = sis.sis_score;
        }
      }
    }

    timing.sis_ms = Date.now() - startSIS;

    sse.send('sis_scores', {
      count: sisResults.length,
      scores: sisResults,
      durationMs: timing.sis_ms
    });

    // Stage 7: Complete with merged results
    const finalResults = [...allResults.values()]
      .sort((a, b) => {
        // Sort by SIS score first, then text score
        const sisA = a.sis_score || 0;
        const sisB = b.sis_score || 0;
        if (sisA !== sisB) return sisB - sisA;
        return (b.text_score || 0) - (a.text_score || 0);
      })
      .slice(0, limit);

    sse.complete({
      total: finalResults.length,
      results: finalResults,
      timing,
      query
    });

  } catch (err) {
    logger.error('streaming_search_error', { query, error: err.message });
    sse.error(err.message);
  }
}
