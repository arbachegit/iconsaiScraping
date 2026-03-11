/**
 * Graph Query Service
 * Provides traversal and analysis queries on the entity graph.
 *
 * Key operations:
 * - Direct relationships (1-hop)
 * - Multi-hop network traversal (recursive CTE, 1-3 hops)
 * - Network statistics
 * - Shortest path between entities
 */

import { supabase } from '../database/supabase.js';
import { createClient } from '@supabase/supabase-js';
import logger from '../utils/logger.js';

const brasilDataHub = process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
  ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
  : null;

/**
 * Get direct (1-hop) relationships for an entity.
 * Returns both outgoing and incoming edges with resolved entity names.
 *
 * @param {string} entityType - Entity type (empresa, pessoa, politico, emenda, noticia)
 * @param {string} entityId - Entity ID
 * @param {Object} [filters={}] - Optional filters
 * @param {string} [filters.tipo_relacao] - Filter by relationship type
 * @param {number} [filters.min_strength] - Minimum strength threshold
 * @param {number} [filters.limit=100] - Max results
 * @returns {Promise<Object>} { relationships, total }
 */
export async function getDirectRelationships(entityType, entityId, filters = {}) {
  try {
    let query = supabase
      .from('fato_relacoes_entidades')
      .select('*', { count: 'exact' })
      .eq('ativo', true)
      .or(
        `and(source_type.eq.${entityType},source_id.eq.${entityId}),and(target_type.eq.${entityType},target_id.eq.${entityId})`
      );

    if (filters.tipo_relacao) {
      query = query.eq('tipo_relacao', filters.tipo_relacao);
    }

    if (filters.min_strength) {
      query = query.gte('strength', filters.min_strength);
    }

    const limit = Math.min(filters.limit || 100, 500);

    const { data, error, count } = await query
      .order('strength', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('get_direct_relationships_error', { entityType, entityId, error: error.message, code: error.code });
      return { relationships: [], total: 0 };
    }

    // Normalize: ensure the queried entity is always the "center"
    const normalized = (data || []).map(rel => {
      const isSource = rel.source_type === entityType && rel.source_id === String(entityId);
      return {
        ...rel,
        direction: isSource ? 'outgoing' : 'incoming',
        neighbor_type: isSource ? rel.target_type : rel.source_type,
        neighbor_id: isSource ? rel.target_id : rel.source_id
      };
    });

    return { relationships: normalized, total: count || normalized.length };
  } catch (err) {
    logger.error('get_direct_relationships_exception', { entityType, entityId, error: err.message });
    return { relationships: [], total: 0 };
  }
}

/**
 * Get multi-hop network graph using recursive CTE.
 * Traverses the graph up to `hops` levels deep with strength/confidence decay.
 *
 * NOTE: Uses Supabase RPC with raw SQL. Requires a Postgres function or
 * falls back to iterative approach using the Supabase client.
 *
 * @param {string} entityType - Starting entity type
 * @param {string} entityId - Starting entity ID
 * @param {number} [hops=2] - Max traversal depth (1-3)
 * @param {number} [limit=200] - Max total nodes
 * @returns {Promise<Object>} { nodes, edges, stats }
 */
export async function getNetworkGraph(entityType, entityId, hops = 2, limit = 200) {
  const maxHops = Math.min(Math.max(hops, 1), 3);
  const maxLimit = Math.min(limit, 500);

  try {
    // Iterative BFS approach (works with Supabase client without raw SQL)
    const visited = new Set();
    const allEdges = [];
    const nodeMap = new Map();

    // Queue: [entityType, entityId, currentHop]
    const queue = [[entityType, String(entityId), 0]];
    visited.add(`${entityType}:${entityId}`);

    // Add root node
    nodeMap.set(`${entityType}:${entityId}`, {
      id: String(entityId),
      type: entityType,
      hop: 0
    });

    while (queue.length > 0 && allEdges.length < maxLimit) {
      const [curType, curId, curHop] = queue.shift();

      if (curHop >= maxHops) continue;

      // Fetch neighbors (both directions)
      const { data: edges, error } = await supabase
        .from('fato_relacoes_entidades')
        .select('*')
        .eq('ativo', true)
        .or(
          `and(source_type.eq.${curType},source_id.eq.${curId}),and(target_type.eq.${curType},target_id.eq.${curId})`
        )
        .order('strength', { ascending: false })
        .limit(50); // Limit per hop to prevent explosion

      if (error || !edges) continue;

      for (const edge of edges) {
        // Determine neighbor
        const isSource = edge.source_type === curType && edge.source_id === curId;
        const neighborType = isSource ? edge.target_type : edge.source_type;
        const neighborId = isSource ? edge.target_id : edge.source_id;
        const neighborKey = `${neighborType}:${neighborId}`;

        // Apply decay to strength/confidence
        const decayFactor = Math.pow(0.5, curHop);
        const decayedEdge = {
          ...edge,
          effective_strength: (edge.strength || 0.5) * decayFactor,
          effective_confidence: (edge.confidence || 0.5) * Math.pow(0.7, curHop),
          hop: curHop + 1
        };

        allEdges.push(decayedEdge);

        if (!visited.has(neighborKey)) {
          visited.add(neighborKey);
          nodeMap.set(neighborKey, {
            id: String(neighborId),
            type: neighborType,
            hop: curHop + 1
          });

          // Only continue BFS if within hop limit
          if (curHop + 1 < maxHops) {
            queue.push([neighborType, neighborId, curHop + 1]);
          }
        }

        if (allEdges.length >= maxLimit) break;
      }
    }

    const idsByType = {};
    for (const node of nodeMap.values()) {
      if (!idsByType[node.type]) idsByType[node.type] = [];
      idsByType[node.type].push(node.id);
    }

    const interNodeOrClauses = [];
    for (const [type, ids] of Object.entries(idsByType)) {
      if (ids.length === 0) continue;
      interNodeOrClauses.push(`and(source_type.eq.${type},source_id.in.(${ids.join(',')}))`);
      interNodeOrClauses.push(`and(target_type.eq.${type},target_id.in.(${ids.join(',')}))`);
    }

    if (interNodeOrClauses.length > 0) {
      const { data: extraEdges, error: extraEdgesError } = await supabase
        .from('fato_relacoes_entidades')
        .select('*')
        .eq('ativo', true)
        .or(interNodeOrClauses.join(','))
        .limit(Math.min(maxLimit * 3, 1500));

      if (extraEdgesError) {
        logger.warn('network_graph_inter_edges_error', {
          entityType,
          entityId,
          error: extraEdgesError.message,
        });
      } else {
        for (const edge of (extraEdges || [])) {
          const srcKey = `${edge.source_type}:${edge.source_id}`;
          const tgtKey = `${edge.target_type}:${edge.target_id}`;
          if (!nodeMap.has(srcKey) || !nodeMap.has(tgtKey)) continue;
          allEdges.push({
            ...edge,
            hop: Math.max(nodeMap.get(srcKey)?.hop || 0, nodeMap.get(tgtKey)?.hop || 0)
          });
          if (allEdges.length >= maxLimit * 3) break;
        }
      }
    }

    // Resolve entity names for nodes
    const nodes = await resolveEntityNames([...nodeMap.values()]);

    // Deduplicate edges (same source-target pair)
    const edgeKeys = new Set();
    const uniqueEdges = allEdges.filter(e => {
      const key = `${e.source_type}:${e.source_id}-${e.target_type}:${e.target_id}-${e.tipo_relacao}`;
      if (edgeKeys.has(key)) return false;
      edgeKeys.add(key);
      return true;
    });

    const stats = {
      total_nodes: nodes.length,
      total_edges: uniqueEdges.length,
      max_hop_reached: Math.max(...[...nodeMap.values()].map(n => n.hop), 0),
      by_type: countByKey(nodes, 'type'),
      by_relationship: countByKey(uniqueEdges, 'tipo_relacao')
    };

    logger.info('network_graph_complete', {
      entityType, entityId, hops: maxHops, nodes: nodes.length, edges: uniqueEdges.length
    });

    return { nodes, edges: uniqueEdges, stats };
  } catch (err) {
    logger.error('network_graph_error', { entityType, entityId, hops, error: err.message });
    return { nodes: [], edges: [], stats: {} };
  }
}

/**
 * Get aggregated network statistics for an entity.
 *
 * @param {string} entityType - Entity type
 * @param {string} entityId - Entity ID
 * @returns {Promise<Object>} Network statistics
 */
export async function getNetworkStats(entityType, entityId) {
  try {
    const { data: edges, error } = await supabase
      .from('fato_relacoes_entidades')
      .select('tipo_relacao, strength, confidence, source_type, target_type')
      .eq('ativo', true)
      .or(
        `and(source_type.eq.${entityType},source_id.eq.${entityId}),and(target_type.eq.${entityType},target_id.eq.${entityId})`
      );

    if (error || !edges) {
      return {
        total_relationships: 0,
        by_type: {},
        by_entity_type: {},
        avg_strength: 0,
        avg_confidence: 0
      };
    }

    const byType = countByKey(edges, 'tipo_relacao');

    // Count connected entity types
    const entityTypes = {};
    for (const edge of edges) {
      const isSource = edge.source_type === entityType;
      const neighborType = isSource ? edge.target_type : edge.source_type;
      entityTypes[neighborType] = (entityTypes[neighborType] || 0) + 1;
    }

    const avgStrength = edges.length > 0
      ? edges.reduce((sum, e) => sum + (e.strength || 0), 0) / edges.length
      : 0;

    const avgConfidence = edges.length > 0
      ? edges.reduce((sum, e) => sum + (e.confidence || 0), 0) / edges.length
      : 0;

    return {
      total_relationships: edges.length,
      by_type: byType,
      by_entity_type: entityTypes,
      avg_strength: Math.round(avgStrength * 100) / 100,
      avg_confidence: Math.round(avgConfidence * 100) / 100
    };
  } catch (err) {
    logger.error('network_stats_error', { entityType, entityId, error: err.message });
    return { total_relationships: 0, by_type: {}, by_entity_type: {}, avg_strength: 0, avg_confidence: 0 };
  }
}

/**
 * Resolve entity names from their IDs.
 * Batch-fetches names from dim_empresas, dim_pessoas, dim_politicos, dim_noticias and mandatos.
 *
 * @param {Array<{id: string, type: string, hop: number}>} nodes
 * @returns {Promise<Array>} Nodes with resolved names
 */
async function resolveEntityNames(nodes) {
  const grouped = {};
  for (const node of nodes) {
    if (!grouped[node.type]) grouped[node.type] = [];
    grouped[node.type].push(node);
  }

  const resolved = [];

  // Resolve empresas
  if (grouped.empresa?.length > 0) {
    const ids = grouped.empresa.map(n => n.id);
    const { data } = await supabase
      .from('dim_empresas')
      .select('id, razao_social, nome_fantasia, cnpj, cidade, estado')
      .in('id', ids);

    const lookup = new Map((data || []).map(d => [String(d.id), d]));
    for (const node of grouped.empresa) {
      const info = lookup.get(String(node.id)) || {};
      resolved.push({
        ...node,
        label: info.nome_fantasia || info.razao_social || `Empresa #${node.id}`,
        cnpj: info.cnpj,
        cidade: info.cidade,
        estado: info.estado
      });
    }
  }

  // Resolve pessoas
  if (grouped.pessoa?.length > 0) {
    const ids = grouped.pessoa.map(n => n.id);
    const { data } = await supabase
      .from('dim_pessoas')
      .select('id, nome_completo, cargo_atual, empresa_atual_nome')
      .in('id', ids);

    const lookup = new Map((data || []).map(d => [String(d.id), d]));
    for (const node of grouped.pessoa) {
      const info = lookup.get(String(node.id)) || {};
      resolved.push({
        ...node,
        label: info.nome_completo || `Pessoa #${node.id}`,
        cargo: info.cargo_atual,
        empresa: info.empresa_atual_nome
      });
    }
  }

  // Resolve politicos
  if (grouped.politico?.length > 0) {
    const ids = grouped.politico.map(n => n.id);
    const { data } = await supabase
      .from('dim_politicos')
      .select('id, nome_completo, partido_sigla, cargo_atual')
      .in('id', ids);

    const lookup = new Map((data || []).map(d => [String(d.id), d]));
    for (const node of grouped.politico) {
      const info = lookup.get(String(node.id)) || {};
      resolved.push({
        ...node,
        label: info.nome_completo || `Político #${node.id}`,
        partido: info.partido_sigla,
        cargo: info.cargo_atual
      });
    }
  }

  // Resolve noticias
  if (grouped.noticia?.length > 0) {
    const ids = grouped.noticia.map(n => n.id);
    const { data } = await supabase
      .from('dim_noticias')
      .select('id, titulo, fonte_nome, data_publicacao')
      .in('id', ids);

    const lookup = new Map((data || []).map(d => [String(d.id), d]));
    for (const node of grouped.noticia) {
      const info = lookup.get(String(node.id)) || {};
      resolved.push({
        ...node,
        label: info.titulo?.substring(0, 80) || `Notícia #${node.id}`,
        fonte: info.fonte_nome,
        data_publicacao: info.data_publicacao
      });
    }
  }

  // Resolve emendas (if table exists)
  if (grouped.emenda?.length > 0) {
    for (const node of grouped.emenda) {
      resolved.push({
        ...node,
        label: `Emenda #${node.id}`
      });
    }
  }

  if (grouped.mandato?.length > 0) {
    const ids = grouped.mandato.map(n => n.id);
    const { data } = brasilDataHub
      ? await brasilDataHub
        .from('fato_politicos_mandatos')
        .select('id, cargo, municipio, ano_eleicao, partido_sigla, eleito')
        .in('id', ids)
      : { data: [] };

    const lookup = new Map((data || []).map(d => [String(d.id), d]));
    for (const node of grouped.mandato) {
      const info = lookup.get(String(node.id)) || {};
      resolved.push({
        ...node,
        label: `${info.cargo || 'Mandato'} ${info.municipio || ''} ${info.ano_eleicao || ''}`.trim() || `Mandato #${node.id}`,
        cargo: info.cargo,
        municipio: info.municipio,
        ano_eleicao: info.ano_eleicao,
        partido: info.partido_sigla,
        eleito: info.eleito,
      });
    }
  }

  return resolved;
}

/**
 * Count occurrences of a key's values in an array of objects.
 * @param {Array} arr
 * @param {string} key
 * @returns {Object} Counts by value
 */
function countByKey(arr, key) {
  const counts = {};
  for (const item of arr) {
    const val = item[key] || 'unknown';
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}
