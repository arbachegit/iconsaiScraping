/**
 * Hybrid Search Service
 * Combines multiple search signals with Reciprocal Rank Fusion (RRF).
 *
 * Search modes:
 * - text: Trigram similarity + full-text search (PostgreSQL)
 * - vector: Semantic similarity via pgvector embeddings
 * - relational: Graph-based discovery via fato_relacoes_entidades
 * - hybrid: All signals combined with RRF ranking
 *
 * RRF formula: score = sum(1 / (k + rank_i)) for each signal
 * Default k = 60 (standard RRF constant)
 */

import { supabase } from '../database/supabase.js';
import { searchCompaniesByName } from './company-search.js';
import logger from '../utils/logger.js';

const RRF_K = 60; // Standard RRF constant

/**
 * Trigram text search using pg_trgm similarity.
 * Falls back to ILIKE if pg_trgm indexes are not ready.
 *
 * @param {string} query - Search query
 * @param {Object} [filters={}] - Optional filters (cidade, estado)
 * @param {number} [limit=50] - Max results
 * @returns {Promise<Array>} Ranked results with text_score
 */
export async function textSearch(query, filters = {}, limit = 50) {
  if (!query || query.length < 2) return [];

  try {
    const data = await searchCompaniesByName({
      query,
      cidade: filters.cidade,
      estado: filters.estado,
      limit,
    });

    // Score results by match quality
    const queryLower = query.toLowerCase();
    return (data || []).map((row, index) => {
      const nameScore = calculateTextSimilarity(
        queryLower,
        (row.nome_fantasia || '').toLowerCase()
      );
      const razaoScore = calculateTextSimilarity(
        queryLower,
        (row.razao_social || '').toLowerCase()
      );

      return {
        ...row,
        text_score: Math.max(nameScore, razaoScore),
        text_rank: index + 1,
        search_source: 'text'
      };
    }).sort((a, b) => b.text_score - a.text_score);
  } catch (err) {
    logger.error('text_search_exception', { query, error: err.message });
    return [];
  }
}

/**
 * Vector (semantic) search using pgvector cosine similarity.
 * Requires embeddings to be populated and pgvector extension enabled.
 *
 * @param {Array<number>} queryEmbedding - Query embedding vector (1536 dims)
 * @param {number} [limit=50] - Max results
 * @returns {Promise<Array>} Results with vector_score
 */
export async function vectorSearch(queryEmbedding, limit = 50) {
  if (!queryEmbedding || queryEmbedding.length === 0) return [];

  try {
    // Use Supabase RPC for vector similarity search
    const { data, error } = await supabase.rpc('match_empresas_by_embedding', {
      query_embedding: queryEmbedding,
      match_count: limit,
      match_threshold: 0.3
    });

    if (error) {
      // If RPC doesn't exist yet, return empty (graceful degradation)
      if (error.code === '42883') {
        logger.debug('vector_search_rpc_missing', { msg: 'match_empresas_by_embedding not found, skipping vector search' });
        return [];
      }
      logger.error('vector_search_error', { error: error.message, code: error.code });
      return [];
    }

    return (data || []).map((row, index) => ({
      ...row,
      vector_score: row.similarity || 0,
      vector_rank: index + 1,
      search_source: 'vector'
    }));
  } catch (err) {
    logger.error('vector_search_exception', { error: err.message });
    return [];
  }
}

/**
 * Relational search using the entity graph.
 * Finds companies connected to entities matching the query.
 *
 * @param {string} query - Search query (used to find seed entities)
 * @param {number} [limit=50] - Max results
 * @returns {Promise<Array>} Results with relational_score
 */
export async function relationalSearch(query, limit = 50) {
  if (!query || query.length < 2) return [];

  try {
    // Find seed entities matching the query
    const seeds = await searchCompaniesByName({ query, limit: 5 });

    if (!seeds || seeds.length === 0) return [];

    // Get connected companies via graph
    const seedIds = seeds.map(s => String(s.id));

    const { data: edges, error: edgeError } = await supabase
      .from('fato_relacoes_entidades')
      .select('target_id, target_type, tipo_relacao, strength, confidence')
      .eq('ativo', true)
      .eq('source_type', 'empresa')
      .in('source_id', seedIds)
      .eq('target_type', 'empresa')
      .order('strength', { ascending: false })
      .limit(limit);

    if (edgeError || !edges) return [];

    // Fetch company details for connected nodes
    const connectedIds = [...new Set(edges.map(e => parseInt(e.target_id)).filter(id => !isNaN(id)))];

    if (connectedIds.length === 0) return [];

    const { data: companies } = await supabase
      .from('dim_empresas')
      .select('id, cnpj, razao_social, nome_fantasia, cidade, estado')
      .in('id', connectedIds);

    if (!companies) return [];

    // Merge with edge scores
    const edgeMap = new Map();
    for (const edge of edges) {
      const id = parseInt(edge.target_id);
      if (!edgeMap.has(id) || edge.strength > edgeMap.get(id).strength) {
        edgeMap.set(id, edge);
      }
    }

    return companies.map((company, index) => {
      const edge = edgeMap.get(company.id) || {};
      return {
        ...company,
        relational_score: (edge.strength || 0) * (edge.confidence || 0),
        relational_rank: index + 1,
        connected_via: edge.tipo_relacao || 'unknown',
        search_source: 'relational'
      };
    }).sort((a, b) => b.relational_score - a.relational_score);
  } catch (err) {
    logger.error('relational_search_exception', { query, error: err.message });
    return [];
  }
}

/**
 * Hybrid search combining all signals with RRF ranking.
 *
 * @param {Object} params
 * @param {string} params.query - Search query
 * @param {Array<number>} [params.queryEmbedding] - Optional embedding for vector search
 * @param {Object} [params.filters={}] - Filters (cidade, estado)
 * @param {string} [params.mode='hybrid'] - Search mode: text, vector, relational, hybrid
 * @param {number} [params.limit=50] - Max results
 * @returns {Promise<Object>} { results, signals, timing }
 */
export async function hybridSearch({ query, queryEmbedding = null, filters = {}, mode = 'hybrid', limit = 50 }) {
  const timing = {};
  const signals = {};

  // Run enabled search modes
  const searches = [];

  if (mode === 'text' || mode === 'hybrid') {
    const startText = Date.now();
    searches.push(
      textSearch(query, filters, limit).then(results => {
        timing.text_ms = Date.now() - startText;
        signals.text = results;
        return results;
      })
    );
  }

  if ((mode === 'vector' || mode === 'hybrid') && queryEmbedding) {
    const startVector = Date.now();
    searches.push(
      vectorSearch(queryEmbedding, limit).then(results => {
        timing.vector_ms = Date.now() - startVector;
        signals.vector = results;
        return results;
      })
    );
  }

  if (mode === 'relational' || mode === 'hybrid') {
    const startRelational = Date.now();
    searches.push(
      relationalSearch(query, limit).then(results => {
        timing.relational_ms = Date.now() - startRelational;
        signals.relational = results;
        return results;
      })
    );
  }

  await Promise.all(searches);

  // Apply RRF fusion
  const fused = applyRRF(signals, limit);

  logger.info('hybrid_search_complete', {
    query,
    mode,
    text_count: signals.text?.length || 0,
    vector_count: signals.vector?.length || 0,
    relational_count: signals.relational?.length || 0,
    fused_count: fused.length,
    timing
  });

  return {
    results: fused,
    signals: {
      text: signals.text?.length || 0,
      vector: signals.vector?.length || 0,
      relational: signals.relational?.length || 0
    },
    timing
  };
}

/**
 * Calculate Strategic Impact Score for a company.
 *
 * @param {number|string} empresaId - Company ID
 * @param {string} [queryContext='default'] - Query context for caching
 * @returns {Promise<Object>} SIS scores
 */
export async function calculateSIS(empresaId, queryContext = 'default') {
  try {
    // Get relationship density
    const { data: rels } = await supabase
      .from('fato_relacoes_entidades')
      .select('tipo_relacao, strength')
      .eq('ativo', true)
      .or(`and(source_type.eq.empresa,source_id.eq.${empresaId}),and(target_type.eq.empresa,target_id.eq.${empresaId})`);

    const totalRels = rels?.length || 0;
    const politicalRels = (rels || []).filter(r =>
      r.tipo_relacao === 'politico_empresarial' || r.tipo_relacao === 'beneficiario'
    ).length;

    // Get news mentions
    const newsRels = (rels || []).filter(r => r.tipo_relacao === 'mencionado_em').length;

    // Get CNAE similar count
    const cnaeRels = (rels || []).filter(r => r.tipo_relacao === 'cnae_similar').length;

    // Get geographic connections
    const geoRels = (rels || []).filter(r => r.tipo_relacao === 'geografico').length;

    // Normalize scores to 0-1 (using logarithmic scaling)
    const scores = {
      text_similarity: 0, // Set externally during search
      geo_proximity: Math.min(geoRels / 10, 1),
      cnae_similarity: Math.min(cnaeRels / 10, 1),
      political_connections: Math.min(politicalRels / 5, 1),
      news_volume: Math.min(newsRels / 10, 1),
      relationship_density: Math.min(totalRels / 20, 1)
    };

    // Upsert to fato_sis_scores
    const { data, error } = await supabase
      .from('fato_sis_scores')
      .upsert({
        empresa_id: parseInt(empresaId),
        ...scores,
        query_context: queryContext,
        calculated_at: new Date().toISOString()
      }, {
        onConflict: 'empresa_id,query_context'
      })
      .select()
      .single();

    if (error) {
      logger.warn('sis_upsert_error', { empresaId, error: error.message });
      // Calculate score manually
      const sisScore = (
        scores.text_similarity * 15 +
        scores.geo_proximity * 10 +
        scores.cnae_similarity * 15 +
        scores.political_connections * 25 +
        scores.news_volume * 15 +
        scores.relationship_density * 20
      );
      return { ...scores, sis_score: Math.round(sisScore * 100) / 100 };
    }

    return data;
  } catch (err) {
    logger.error('calculate_sis_error', { empresaId, error: err.message });
    return null;
  }
}

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Apply Reciprocal Rank Fusion across multiple signal lists.
 *
 * @param {Object} signals - { text: [], vector: [], relational: [] }
 * @param {number} limit - Max results
 * @returns {Array} Fused and ranked results
 */
function applyRRF(signals, limit) {
  const scoreMap = new Map(); // id -> { company, rrf_score, sources }

  for (const [signalName, results] of Object.entries(signals)) {
    if (!results) continue;

    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank];
      const id = item.id;
      const rrfContribution = 1 / (RRF_K + rank + 1);

      if (scoreMap.has(id)) {
        const existing = scoreMap.get(id);
        existing.rrf_score += rrfContribution;
        existing.sources.push(signalName);
        existing[`${signalName}_score`] = item[`${signalName}_score`] || item.text_score || item.vector_score || item.relational_score || 0;
        existing[`${signalName}_rank`] = rank + 1;
      } else {
        scoreMap.set(id, {
          ...item,
          rrf_score: rrfContribution,
          sources: [signalName],
          [`${signalName}_score`]: item[`${signalName}_score`] || item.text_score || item.vector_score || item.relational_score || 0,
          [`${signalName}_rank`]: rank + 1
        });
      }
    }
  }

  // Sort by RRF score descending
  return [...scoreMap.values()]
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, limit)
    .map((item, index) => ({
      ...item,
      final_rank: index + 1,
      source_count: item.sources.length
    }));
}

/**
 * Simple text similarity score based on substring matching.
 * Returns 0-1 score.
 */
function calculateTextSimilarity(query, text) {
  if (!query || !text) return 0;

  // Exact match
  if (text === query) return 1.0;

  // Starts with
  if (text.startsWith(query)) return 0.9;

  // Contains
  if (text.includes(query)) return 0.7;

  // Partial word match
  const queryWords = query.split(/\s+/);
  const textWords = text.split(/\s+/);
  const matchedWords = queryWords.filter(qw =>
    textWords.some(tw => tw.includes(qw) || qw.includes(tw))
  );

  return matchedWords.length > 0
    ? (matchedWords.length / queryWords.length) * 0.5
    : 0;
}
