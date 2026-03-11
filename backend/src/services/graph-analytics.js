/**
 * Graph Analytics Service
 * Server-side graph analysis: centrality, community detection, influence scoring.
 * Operates on data from fato_relacoes_entidades.
 */

import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';

/**
 * Load the local subgraph around an entity for analytics.
 * Returns adjacency structure ready for algorithm processing.
 *
 * @param {string} entityType
 * @param {string} entityId
 * @param {number} [hops=2]
 * @returns {Promise<{nodes: Map, edges: Array, adj: Map}>}
 */
async function loadSubgraph(entityType, entityId, hops = 2) {
  const maxHops = Math.min(Math.max(hops, 1), 3);
  const visited = new Map(); // key -> { type, id, hop }
  const allEdges = [];
  const queue = [[entityType, String(entityId), 0]];
  const rootKey = `${entityType}:${entityId}`;
  visited.set(rootKey, { type: entityType, id: String(entityId), hop: 0 });

  while (queue.length > 0 && visited.size < 500) {
    const [curType, curId, curHop] = queue.shift();
    if (curHop >= maxHops) continue;

    const { data: edges, error } = await supabase
      .from('fato_relacoes_entidades')
      .select('id, source_type, source_id, target_type, target_id, tipo_relacao, strength, confidence')
      .eq('ativo', true)
      .or(`and(source_type.eq.${curType},source_id.eq.${curId}),and(target_type.eq.${curType},target_id.eq.${curId})`)
      .order('strength', { ascending: false })
      .limit(50);

    if (error || !edges) continue;

    for (const edge of edges) {
      const isSource = edge.source_type === curType && edge.source_id === curId;
      const nType = isSource ? edge.target_type : edge.source_type;
      const nId = isSource ? edge.target_id : edge.source_id;
      const nKey = `${nType}:${nId}`;

      allEdges.push(edge);

      if (!visited.has(nKey)) {
        visited.set(nKey, { type: nType, id: String(nId), hop: curHop + 1 });
        if (curHop + 1 < maxHops) {
          queue.push([nType, nId, curHop + 1]);
        }
      }
    }
  }

  // Build adjacency list
  const adj = new Map();
  for (const key of visited.keys()) adj.set(key, []);

  // Deduplicate edges
  const edgeKeys = new Set();
  const uniqueEdges = [];
  for (const e of allEdges) {
    const k = `${e.source_type}:${e.source_id}-${e.target_type}:${e.target_id}-${e.tipo_relacao}`;
    if (edgeKeys.has(k)) continue;
    edgeKeys.add(k);
    uniqueEdges.push(e);

    const sKey = `${e.source_type}:${e.source_id}`;
    const tKey = `${e.target_type}:${e.target_id}`;

    if (adj.has(sKey)) adj.get(sKey).push({ neighbor: tKey, weight: e.strength || 0.5 });
    if (adj.has(tKey)) adj.get(tKey).push({ neighbor: sKey, weight: e.strength || 0.5 });
  }

  return { nodes: visited, edges: uniqueEdges, adj };
}

/**
 * Degree centrality: normalized count of connections per node.
 * @param {Map} adj - Adjacency list
 * @returns {Map<string, number>}
 */
function degreeCentrality(adj) {
  const result = new Map();
  let max = 1;
  for (const [key, neighbors] of adj) {
    result.set(key, neighbors.length);
    if (neighbors.length > max) max = neighbors.length;
  }
  for (const [key, val] of result) result.set(key, val / max);
  return result;
}

/**
 * Betweenness centrality: fraction of shortest paths through each node.
 * Brandes algorithm, O(V*E).
 * @param {Map} adj
 * @returns {Map<string, number>}
 */
function betweennessCentrality(adj) {
  const nodes = [...adj.keys()];
  const bc = new Map();
  for (const n of nodes) bc.set(n, 0);

  for (const s of nodes) {
    const dist = new Map();
    const sigma = new Map();
    const pred = new Map();
    const stack = [];

    dist.set(s, 0);
    sigma.set(s, 1);
    const queue = [s];

    while (queue.length > 0) {
      const v = queue.shift();
      stack.push(v);
      const d = dist.get(v);
      for (const { neighbor: w } of adj.get(v) || []) {
        if (!dist.has(w)) {
          dist.set(w, d + 1);
          queue.push(w);
        }
        if (dist.get(w) === d + 1) {
          sigma.set(w, (sigma.get(w) || 0) + (sigma.get(v) || 0));
          if (!pred.has(w)) pred.set(w, []);
          pred.get(w).push(v);
        }
      }
    }

    const delta = new Map();
    for (const n of nodes) delta.set(n, 0);
    while (stack.length > 0) {
      const w = stack.pop();
      for (const v of pred.get(w) || []) {
        const d = (delta.get(v) || 0) + ((sigma.get(v) || 1) / (sigma.get(w) || 1)) * (1 + (delta.get(w) || 0));
        delta.set(v, d);
      }
      if (w !== s) bc.set(w, (bc.get(w) || 0) + (delta.get(w) || 0));
    }
  }

  const max = Math.max(1, ...bc.values());
  for (const [key, val] of bc) bc.set(key, val / max);
  return bc;
}

/**
 * PageRank: iterative power method.
 * @param {Map} adj
 * @param {number} [iterations=20]
 * @param {number} [damping=0.85]
 * @returns {Map<string, number>}
 */
function pageRank(adj, iterations = 20, damping = 0.85) {
  const nodes = [...adj.keys()];
  const n = nodes.length;
  if (n === 0) return new Map();

  let rank = new Map();
  for (const node of nodes) rank.set(node, 1 / n);

  for (let i = 0; i < iterations; i++) {
    const newRank = new Map();
    for (const node of nodes) {
      let sum = 0;
      for (const { neighbor } of adj.get(node) || []) {
        const deg = (adj.get(neighbor) || []).length || 1;
        sum += (rank.get(neighbor) || 0) / deg;
      }
      newRank.set(node, (1 - damping) / n + damping * sum);
    }
    rank = newRank;
  }

  const max = Math.max(1e-10, ...rank.values());
  for (const [key, val] of rank) rank.set(key, val / max);
  return rank;
}

/**
 * Closeness centrality: inverse of average shortest path distance.
 * @param {Map} adj
 * @returns {Map<string, number>}
 */
function closenessCentrality(adj) {
  const nodes = [...adj.keys()];
  const result = new Map();

  for (const s of nodes) {
    // BFS from s
    const dist = new Map();
    dist.set(s, 0);
    const queue = [s];
    while (queue.length > 0) {
      const v = queue.shift();
      const d = dist.get(v);
      for (const { neighbor } of adj.get(v) || []) {
        if (!dist.has(neighbor)) {
          dist.set(neighbor, d + 1);
          queue.push(neighbor);
        }
      }
    }

    const totalDist = [...dist.values()].reduce((sum, d) => sum + d, 0);
    const reachable = dist.size - 1;
    result.set(s, reachable > 0 ? reachable / totalDist : 0);
  }

  const max = Math.max(1e-10, ...result.values());
  for (const [key, val] of result) result.set(key, val / max);
  return result;
}

/**
 * Label propagation community detection.
 * Simple, fast community detection (O(E) per iteration).
 * @param {Map} adj
 * @param {number} [maxIter=10]
 * @returns {Map<string, number>} node -> community label (integer)
 */
function detectCommunities(adj, maxIter = 10) {
  const nodes = [...adj.keys()];
  const labels = new Map();
  nodes.forEach((n, i) => labels.set(n, i));

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    // Shuffle order for better convergence
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);

    for (const node of shuffled) {
      const neighbors = adj.get(node) || [];
      if (neighbors.length === 0) continue;

      // Count neighbor labels
      const counts = new Map();
      for (const { neighbor } of neighbors) {
        const lbl = labels.get(neighbor);
        counts.set(lbl, (counts.get(lbl) || 0) + 1);
      }

      // Pick most frequent label
      let bestLabel = labels.get(node);
      let bestCount = 0;
      for (const [lbl, cnt] of counts) {
        if (cnt > bestCount) { bestCount = cnt; bestLabel = lbl; }
      }

      if (labels.get(node) !== bestLabel) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Normalize labels to 0-based sequential
  const uniqueLabels = [...new Set(labels.values())];
  const labelMap = new Map();
  uniqueLabels.forEach((l, i) => labelMap.set(l, i));

  const result = new Map();
  for (const [node, lbl] of labels) result.set(node, labelMap.get(lbl));
  return result;
}

/**
 * Find bridge edges: edges whose removal would disconnect components.
 * Uses Tarjan's bridge-finding algorithm.
 * @param {Map} adj
 * @returns {Array<[string, string]>}
 */
function findBridges(adj) {
  const nodes = [...adj.keys()];
  const disc = new Map();
  const low = new Map();
  const visited = new Set();
  const bridges = [];
  let timer = 0;

  function dfs(u, parent) {
    visited.add(u);
    disc.set(u, timer);
    low.set(u, timer);
    timer++;

    for (const { neighbor: v } of adj.get(u) || []) {
      if (!visited.has(v)) {
        dfs(v, u);
        low.set(u, Math.min(low.get(u), low.get(v)));
        if (low.get(v) > disc.get(u)) {
          bridges.push([u, v]);
        }
      } else if (v !== parent) {
        low.set(u, Math.min(low.get(u), disc.get(v)));
      }
    }
  }

  for (const n of nodes) {
    if (!visited.has(n)) dfs(n, null);
  }

  return bridges;
}

/**
 * Compute full graph analytics for an entity's network.
 *
 * @param {string} entityType
 * @param {string} entityId
 * @param {Object} [options={}]
 * @param {number} [options.hops=2]
 * @returns {Promise<Object>} Full analytics result
 */
export async function computeGraphAnalytics(entityType, entityId, options = {}) {
  const startTime = Date.now();
  const hops = options.hops || 2;

  try {
    const { nodes, edges, adj } = await loadSubgraph(entityType, entityId, hops);

    if (nodes.size === 0) {
      return { error: 'Nenhum nó encontrado na rede', nodes: 0, edges: 0 };
    }

    const rootKey = `${entityType}:${entityId}`;

    // Compute all centrality metrics
    const degree = degreeCentrality(adj);
    const betweenness = betweennessCentrality(adj);
    const pr = pageRank(adj);
    const closeness = closenessCentrality(adj);

    // Community detection
    const communities = detectCommunities(adj);

    // Bridge edges
    const bridges = findBridges(adj);

    // Root node metrics
    const rootMetrics = {
      degree: degree.get(rootKey) || 0,
      betweenness: betweenness.get(rootKey) || 0,
      pagerank: pr.get(rootKey) || 0,
      closeness: closeness.get(rootKey) || 0,
      community: communities.get(rootKey) ?? -1,
      direct_connections: (adj.get(rootKey) || []).length,
    };

    // Top influencers by composite score
    const influenceScores = new Map();
    for (const key of nodes.keys()) {
      const score = (degree.get(key) || 0) * 0.25
        + (betweenness.get(key) || 0) * 0.30
        + (pr.get(key) || 0) * 0.30
        + (closeness.get(key) || 0) * 0.15;
      influenceScores.set(key, Math.round(score * 100) / 100);
    }

    const topInfluencers = [...influenceScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, score]) => {
        const node = nodes.get(key);
        return {
          key,
          type: node.type,
          id: node.id,
          score,
          degree: Math.round((degree.get(key) || 0) * 100) / 100,
          betweenness: Math.round((betweenness.get(key) || 0) * 100) / 100,
          pagerank: Math.round((pr.get(key) || 0) * 100) / 100,
        };
      });

    // Community summary
    const communityGroups = new Map();
    for (const [key, comm] of communities) {
      if (!communityGroups.has(comm)) communityGroups.set(comm, []);
      communityGroups.get(comm).push(key);
    }

    const communitySummary = [...communityGroups.entries()]
      .map(([id, members]) => ({
        id,
        size: members.length,
        members: members.slice(0, 5).map(k => {
          const n = nodes.get(k);
          return { type: n.type, id: n.id };
        }),
      }))
      .sort((a, b) => b.size - a.size);

    // Relationship type distribution
    const relTypes = {};
    for (const e of edges) {
      relTypes[e.tipo_relacao] = (relTypes[e.tipo_relacao] || 0) + 1;
    }

    // Avg strength and confidence
    const avgStrength = edges.length > 0
      ? edges.reduce((s, e) => s + (e.strength || 0), 0) / edges.length
      : 0;
    const avgConfidence = edges.length > 0
      ? edges.reduce((s, e) => s + (e.confidence || 0), 0) / edges.length
      : 0;

    const duration = Date.now() - startTime;

    logger.info('graph_analytics_complete', {
      entityType, entityId, nodes: nodes.size, edges: edges.length,
      communities: communitySummary.length, bridges: bridges.length, duration_ms: duration,
    });

    return {
      summary: {
        total_nodes: nodes.size,
        total_edges: edges.length,
        total_communities: communitySummary.length,
        total_bridges: bridges.length,
        avg_strength: Math.round(avgStrength * 100) / 100,
        avg_confidence: Math.round(avgConfidence * 100) / 100,
        relationship_types: relTypes,
      },
      root_metrics: rootMetrics,
      top_influencers: topInfluencers,
      communities: communitySummary,
      bridges: bridges.slice(0, 20).map(([a, b]) => ({
        from: { type: nodes.get(a)?.type, id: nodes.get(a)?.id },
        to: { type: nodes.get(b)?.type, id: nodes.get(b)?.id },
      })),
      duration_ms: duration,
    };
  } catch (err) {
    logger.error('graph_analytics_error', { entityType, entityId, error: err.message });
    return { error: err.message, nodes: 0, edges: 0 };
  }
}

/**
 * Compute influence score for a specific entity in the network.
 * Lighter than full analytics — only computes degree + pagerank.
 *
 * @param {string} entityType
 * @param {string} entityId
 * @returns {Promise<Object>} { influence_score, degree, pagerank, connections }
 */
export async function computeInfluenceScore(entityType, entityId) {
  try {
    const { nodes, adj } = await loadSubgraph(entityType, entityId, 2);
    const rootKey = `${entityType}:${entityId}`;

    const degree = degreeCentrality(adj);
    const pr = pageRank(adj, 15);

    const degreeScore = degree.get(rootKey) || 0;
    const pagerankScore = pr.get(rootKey) || 0;
    const connections = (adj.get(rootKey) || []).length;
    const influenceScore = Math.round((degreeScore * 0.4 + pagerankScore * 0.6) * 100);

    return {
      influence_score: influenceScore,
      degree: Math.round(degreeScore * 100) / 100,
      pagerank: Math.round(pagerankScore * 100) / 100,
      connections,
      network_size: nodes.size,
    };
  } catch (err) {
    logger.error('influence_score_error', { entityType, entityId, error: err.message });
    return { influence_score: 0, degree: 0, pagerank: 0, connections: 0, network_size: 0 };
  }
}
