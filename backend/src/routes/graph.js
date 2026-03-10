import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getNetworkGraph, getNetworkStats } from '../services/graph-queries.js';
import {
  ensureCompanyGraphMaterialized,
  getCompanyGraphContext,
  getCompanyGraphCoverage,
  evaluateCompanyGraphCoverage,
} from '../services/graph-materialization.js';
import { supabase } from '../database/supabase.js';
import {
  getEstimatedCompanyCount,
  listCompanyNodes,
  searchCompaniesByName,
} from '../services/company-search.js';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';

const router = Router();

// Brasil Data Hub client (dim_politicos, fato_emendas_parlamentares)
const brasilDataHub = process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
  ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
  : null;

function makeGraphNodeId(type, id) {
  return `${type}:${id}`;
}

function getRawEntityId(value) {
  const str = String(value || '');
  const idx = str.indexOf(':');
  return idx === -1 ? str : str.slice(idx + 1);
}

function normalizeGraphNode(node) {
  return {
    ...node,
    id: makeGraphNodeId(node.type, node.id),
    data: {
      ...(node.data || {}),
      entityId: String(node.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve entity names for an array of {id, type} nodes
// ---------------------------------------------------------------------------
async function resolveNodeLabels(nodes) {
  const grouped = {};
  for (const node of nodes) {
    if (!grouped[node.type]) grouped[node.type] = [];
    grouped[node.type].push(node);
  }

  const resolved = [];

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
        data: { cnpj: info.cnpj, cidade: info.cidade, estado: info.estado }
      });
    }
  }

  if (grouped.pessoa?.length > 0) {
    const ids = grouped.pessoa.map(n => n.id);
    const { data } = await supabase
      .from('dim_pessoas')
      .select('id, nome_completo, cargo_atual, empresa_atual')
      .in('id', ids);
    const lookup = new Map((data || []).map(d => [String(d.id), d]));
    for (const node of grouped.pessoa) {
      const info = lookup.get(String(node.id)) || {};
      resolved.push({
        ...node,
        label: info.nome_completo || `Pessoa #${node.id}`,
        data: { cargo: info.cargo_atual, empresa: info.empresa_atual }
      });
    }
  }

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
        label: info.nome_completo || `Politico #${node.id}`,
        data: { partido: info.partido_sigla, cargo: info.cargo_atual }
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
        data: {
          cargo: info.cargo,
          municipio: info.municipio,
          ano: info.ano_eleicao,
          partido: info.partido_sigla,
          eleito: info.eleito
        }
      });
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// GET /data  - Full graph data for initial load
// ---------------------------------------------------------------------------
router.get('/data', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const entityType = req.query.entity_type || null;
    const cursorId = req.query.cursor_id ? String(req.query.cursor_id) : null;

    // ------ Fetch nodes from dimension tables ------
    const nodePromises = [];

    if (!entityType || entityType === 'empresa') {
      nodePromises.push(
        listCompanyNodes({ limit, cursorId })
          .then((data) => (data || []).map(d => ({
            id: String(d.id),
            type: 'empresa',
            label: d.nome_fantasia || d.razao_social || `Empresa #${d.id}`,
            data: { cnpj: d.cnpj, cidade: d.cidade, estado: d.estado, entityId: String(d.id) }
          })))
      );
    }

    if (!entityType || entityType === 'pessoa') {
      nodePromises.push(
        supabase
          .from('dim_pessoas')
          .select('id, nome_completo, cargo_atual, empresa_atual')
          .order('created_at', { ascending: false })
          .limit(limit)
          .then(({ data }) => (data || []).map(d => ({
            id: String(d.id),
            type: 'pessoa',
            label: d.nome_completo || `Pessoa #${d.id}`,
            data: { cargo: d.cargo_atual, empresa: d.empresa_atual, entityId: String(d.id) }
          })))
      );
    }

    if (!entityType || entityType === 'politico') {
      nodePromises.push(
        supabase
          .from('dim_politicos')
          .select('id, nome_completo, partido_sigla, cargo_atual')
          .order('created_at', { ascending: false })
          .limit(limit)
          .then(({ data }) => (data || []).map(d => ({
            id: String(d.id),
            type: 'politico',
            label: d.nome_completo || `Politico #${d.id}`,
            data: { partido: d.partido_sigla, cargo: d.cargo_atual, entityId: String(d.id) }
          })))
      );
    }

    if ((!entityType || entityType === 'mandato') && brasilDataHub) {
      nodePromises.push(
        brasilDataHub
          .from('fato_politicos_mandatos')
          .select('id, cargo, municipio, ano_eleicao, partido_sigla, eleito')
          .order('ano_eleicao', { ascending: false })
          .limit(limit)
          .then(({ data }) => (data || []).map(d => ({
            id: String(d.id),
            type: 'mandato',
            label: `${d.cargo || 'Mandato'} ${d.municipio || ''} ${d.ano_eleicao || ''}`.trim() || `Mandato #${d.id}`,
            data: {
              cargo: d.cargo,
              municipio: d.municipio,
              ano: d.ano_eleicao,
              partido: d.partido_sigla,
              eleito: d.eleito,
              entityId: String(d.id)
            }
          })))
      );
    }

    // ------ Fetch edges ------
    const edgesPromise = supabase
      .from('fato_relacoes_entidades')
      .select('id, source_type, source_id, target_type, target_id, tipo_relacao, strength')
      .eq('ativo', true)
      .order('strength', { ascending: false })
      .limit(500);

    const [nodeArrays, { data: edgesRaw, error: edgesError }] = await Promise.all([
      Promise.all(nodePromises),
      edgesPromise
    ]);

    const nodes = nodeArrays.flat().map(normalizeGraphNode);

    if (edgesError) {
      logger.error('graph_data_edges_error', { error: edgesError.message, code: edgesError.code });
    }

    const edges = (edgesRaw || []).map(e => ({
      id: String(e.id),
      source: makeGraphNodeId(e.source_type, e.source_id),
      target: makeGraphNodeId(e.target_type, e.target_id),
      tipo_relacao: e.tipo_relacao,
      strength: e.strength
    }));

    logger.info('graph_data_loaded', { total_nodes: nodes.length, total_edges: edges.length, entity_type: entityType });

    return res.json({
      success: true,
      nodes,
      edges,
      next_cursor_id: entityType === 'empresa' || !entityType
        ? (nodes.filter(n => n.type === 'empresa').at(-1)?.data?.entityId || null)
        : null,
      total_nodes: nodes.length,
      total_edges: edges.length
    });
  } catch (err) {
    logger.error('graph_data_error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Failed to load graph data' });
  }
});

// ---------------------------------------------------------------------------
// GET /expand/:entityType/:entityId  - Expand a node (1-hop neighbors)
// ---------------------------------------------------------------------------
router.get('/expand/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

    const validTypes = ['empresa', 'pessoa', 'politico', 'mandato', 'emenda', 'noticia'];
    if (!validTypes.includes(entityType)) {
      return res.status(400).json({ success: false, error: `Invalid entity type. Must be one of: ${validTypes.join(', ')}` });
    }

    if (!entityId) {
      return res.status(400).json({ success: false, error: 'Entity ID is required' });
    }

    let materialization = null;
    if (entityType === 'empresa') {
      materialization = await ensureCompanyGraphMaterialized(entityId, { force: forceRefresh });
    }

    const result = await getNetworkGraph(entityType, entityId, 1, 50);

    // The center node is the one with hop === 0
    const centerNode = result.nodes.find(n => n.hop === 0) || { id: entityId, type: entityType, label: `${entityType} #${entityId}` };

    const nodes = result.nodes.map(n => ({
      id: makeGraphNodeId(n.type, n.id),
      type: n.type,
      label: n.label,
      data: { hop: n.hop, cnpj: n.cnpj, cargo: n.cargo, partido: n.partido, entityId: String(n.id) }
    }));

    const edges = result.edges.map(e => ({
      id: String(e.id),
      source: makeGraphNodeId(e.source_type, e.source_id),
      target: makeGraphNodeId(e.target_type, e.target_id),
      tipo_relacao: e.tipo_relacao,
      strength: e.strength
    }));

    logger.info('graph_expand', { entityType, entityId, nodes: nodes.length, edges: edges.length });

    return res.json({
      success: true,
      nodes,
      edges,
      center: { id: makeGraphNodeId(centerNode.type, centerNode.id), type: centerNode.type, label: centerNode.label },
      materialization: entityType === 'empresa' ? materialization : null,
    });
  } catch (err) {
    logger.error('graph_expand_error', { entityType: req.params.entityType, entityId: req.params.entityId, error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to expand node' });
  }
});

// ---------------------------------------------------------------------------
// GET /materialization/empresa/:empresaId - Coverage diagnosis for central graph
// ---------------------------------------------------------------------------
router.get('/materialization/empresa/:empresaId', async (req, res) => {
  try {
    const { empresaId } = req.params;
    const context = await getCompanyGraphContext(empresaId);

    if (!context) {
      return res.status(404).json({ success: false, error: 'Company not found' });
    }

    const coverage = await getCompanyGraphCoverage(empresaId);
    const evaluation = evaluateCompanyGraphCoverage(context, coverage);

    return res.json({
      success: true,
      empresa: {
        id: String(context.empresa.id),
        nome: context.nome,
        cnpj: context.empresa.cnpj,
        cidade: context.cidade,
        estado: context.estado,
        cnae_principal: context.cnae_principal,
      },
      source_context: {
        socios: context.socios.length,
      },
      coverage,
      evaluation,
    });
  } catch (err) {
    logger.error('graph_materialization_diagnosis_error', { empresaId: req.params.empresaId, error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to load graph materialization diagnosis' });
  }
});

// ---------------------------------------------------------------------------
// POST /materialize/empresa/:empresaId - Force central graph materialization
// ---------------------------------------------------------------------------
router.post('/materialize/empresa/:empresaId', async (req, res) => {
  try {
    const { empresaId } = req.params;
    const result = await ensureCompanyGraphMaterialized(empresaId, { force: true });

    return res.json({
      success: true,
      result,
    });
  } catch (err) {
    logger.error('graph_materialize_company_error', { empresaId: req.params.empresaId, error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to materialize company graph' });
  }
});

// ---------------------------------------------------------------------------
// GET /search  - Search entities for graph lookup
// ---------------------------------------------------------------------------
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 25);
    const escaped = escapeLike(q);
    // Word-start matching: "cesla" matches "Cesla" but NOT "Venceslau"
    const startPattern = `${escaped}%`;
    const wordPattern = `% ${escaped}%`;

    // Search all entity types in parallel (22M rows — avoid full scan)
    const upperQ = q.toUpperCase();
    const escapedUpper = escapeLike(upperQ);
    let pessoasQuery;
    if (upperQ.split(/\s+/).length === 1) {
      // Single word: primeiro_nome exact match OR nome_completo starts-with
      pessoasQuery = supabase
        .from('dim_pessoas')
        .select('id, nome_completo, cargo_atual, empresa_atual')
        .or(`primeiro_nome.eq.${escapedUpper},nome_completo.ilike.${escapedUpper}%`)
        .limit(200);
    } else {
      // Multi-word: contains match on nome_completo
      pessoasQuery = supabase
        .from('dim_pessoas')
        .select('id, nome_completo, cargo_atual, empresa_atual')
        .ilike('nome_completo', `%${escapedUpper}%`)
        .limit(200);
    }

    const searchPromises = [
      // Empresas
      searchCompaniesByName({ query: q, limit }),
      // Pessoas (all from DB when short query, contains-match otherwise)
      pessoasQuery,
      // Noticias
      supabase
        .from('dim_noticias')
        .select('id, titulo, fonte_nome, data_publicacao')
        .or(`titulo.ilike.${startPattern},titulo.ilike.${wordPattern}`)
        .limit(limit),
    ];

    // Politicos + Emendas from brasilDataHub (if configured)
    if (brasilDataHub) {
      searchPromises.push(
        brasilDataHub
          .from('dim_politicos')
          .select('id, nome_completo, nome_urna, partido_sigla, cargo_atual')
          .or(`nome_completo.ilike.${startPattern},nome_completo.ilike.${wordPattern},nome_urna.ilike.${startPattern},nome_urna.ilike.${wordPattern}`)
          .limit(limit),
        brasilDataHub
          .from('fato_politicos_mandatos')
          .select('id, cargo, municipio, ano_eleicao, partido_sigla, eleito')
          .or(`cargo.ilike.${startPattern},cargo.ilike.${wordPattern},municipio.ilike.${startPattern},municipio.ilike.${wordPattern}`)
          .limit(limit),
        brasilDataHub
          .from('fato_emendas_parlamentares')
          .select('id, autor, tipo, valor_empenhado, ano, uf')
          .or(`autor.ilike.${startPattern},autor.ilike.${wordPattern}`)
          .limit(limit)
      );
    }

    const [empresasRes, pessoasRes, noticiasRes, ...optionalRes] = await Promise.all(searchPromises);
    const politicosRes = optionalRes[0] || { data: [] };
    const mandatosRes = optionalRes[1] || { data: [] };
    const emendasRes = optionalRes[2] || { data: [] };

    const results = [];

    for (const e of (empresasRes || [])) {
      results.push({
        id: String(e.id),
        type: 'empresa',
        label: e.nome_fantasia || e.razao_social,
        subtitle: [e.cnpj, e.cidade, e.estado].filter(Boolean).join(' - ')
      });
    }

    for (const p of (pessoasRes.data || [])) {
      results.push({
        id: String(p.id),
        type: 'pessoa',
        label: p.nome_completo,
        subtitle: [p.cargo_atual, p.empresa_atual].filter(Boolean).join(' @ ')
      });
    }

    for (const pol of (politicosRes.data || [])) {
      results.push({
        id: String(pol.id),
        type: 'politico',
        label: pol.nome_urna || pol.nome_completo,
        subtitle: [pol.partido_sigla, pol.cargo_atual].filter(Boolean).join(' - ')
      });
    }

    for (const mandato of (mandatosRes.data || [])) {
      results.push({
        id: String(mandato.id),
        type: 'mandato',
        label: `${mandato.cargo || 'Mandato'} ${mandato.municipio || ''} ${mandato.ano_eleicao || ''}`.trim(),
        subtitle: [mandato.partido_sigla, mandato.eleito ? 'Eleito' : 'Nao eleito'].filter(Boolean).join(' - ')
      });
    }

    for (const n of (noticiasRes.data || [])) {
      results.push({
        id: String(n.id),
        type: 'noticia',
        label: (n.titulo || '').substring(0, 80),
        subtitle: [n.fonte_nome, n.data_publicacao].filter(Boolean).join(' - ')
      });
    }

    for (const em of (emendasRes.data || [])) {
      results.push({
        id: String(em.id),
        type: 'emenda',
        label: em.autor,
        subtitle: [em.tipo, em.ano, em.uf].filter(Boolean).join(' - ')
      });
    }

    logger.info('graph_search', { query: q, results: results.length });

    // Pessoas are not capped — return all from DB as a directory
    return res.json({ success: true, results });
  } catch (err) {
    logger.error('graph_search_error', { query: req.query.q, error: err.message });
    return res.status(500).json({ success: false, error: 'Search failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /path/:sourceType/:sourceId/:targetType/:targetId  - Shortest path (BFS)
// ---------------------------------------------------------------------------
router.get('/path/:sourceType/:sourceId/:targetType/:targetId', async (req, res) => {
  try {
    const { sourceType, sourceId, targetType, targetId } = req.params;
    const MAX_HOPS = 5;

    const validTypes = ['empresa', 'pessoa', 'politico', 'mandato', 'emenda', 'noticia'];
    if (!validTypes.includes(sourceType) || !validTypes.includes(targetType)) {
      return res.status(400).json({ success: false, error: `Invalid entity type. Must be one of: ${validTypes.join(', ')}` });
    }

    const targetKey = `${targetType}:${targetId}`;
    const visited = new Set();
    visited.add(`${sourceType}:${sourceId}`);

    // BFS: each item is { type, id, path: [{type, id}], edges: [{source, target, tipo_relacao}] }
    let queue = [{ type: sourceType, id: String(sourceId), path: [{ id: String(sourceId), type: sourceType }], edges: [] }];

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      if (queue.length === 0) break;

      const nextQueue = [];

      for (const current of queue) {
        const { data: rels, error } = await supabase
          .from('fato_relacoes_entidades')
          .select('source_type, source_id, target_type, target_id, tipo_relacao')
          .eq('ativo', true)
          .or(
            `and(source_type.eq.${current.type},source_id.eq.${current.id}),and(target_type.eq.${current.type},target_id.eq.${current.id})`
          )
          .limit(100);

        if (error || !rels) continue;

        for (const rel of rels) {
          const isSource = rel.source_type === current.type && rel.source_id === current.id;
          const neighborType = isSource ? rel.target_type : rel.source_type;
          const neighborId = isSource ? rel.target_id : rel.source_id;
          const neighborKey = `${neighborType}:${neighborId}`;

          if (visited.has(neighborKey)) continue;
          visited.add(neighborKey);

          const newPath = [...current.path, { id: String(neighborId), type: neighborType }];
          const newEdges = [...current.edges, {
            source: String(rel.source_id),
            target: String(rel.target_id),
            tipo_relacao: rel.tipo_relacao
          }];

          if (neighborKey === targetKey) {
            // Found - resolve labels
            const resolved = await resolveNodeLabels(newPath);
            const labelMap = new Map(resolved.map(n => [`${n.type}:${n.id}`, n.label]));
            const pathWithLabels = newPath.map(n => ({
              ...n,
              label: labelMap.get(`${n.type}:${n.id}`) || `${n.type} #${n.id}`
            }));

            logger.info('graph_path_found', { sourceType, sourceId, targetType, targetId, hops: hop + 1 });

            return res.json({
              success: true,
              path: pathWithLabels,
              edges: newEdges,
              hops: hop + 1
            });
          }

          nextQueue.push({ type: neighborType, id: String(neighborId), path: newPath, edges: newEdges });
        }
      }

      queue = nextQueue;
    }

    logger.info('graph_path_not_found', { sourceType, sourceId, targetType, targetId });

    return res.json({ success: false, message: 'No path found' });
  } catch (err) {
    logger.error('graph_path_error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Path search failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /stats  - Graph-wide statistics
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const [empresasCount, pessoasCount, politicosCount, edgesRes] = await Promise.all([
      getEstimatedCompanyCount(),
      supabase.from('dim_pessoas').select('id', { count: 'exact', head: true }),
      supabase.from('dim_politicos').select('id', { count: 'exact', head: true }),
      supabase.from('fato_relacoes_entidades').select('tipo_relacao, strength, source_type, source_id, target_type, target_id').eq('ativo', true)
    ]);

    const nodes_by_type = {
      empresa: empresasCount || 0,
      pessoa: pessoasCount.count || 0,
      politico: politicosCount.count || 0
    };

    const edges = edgesRes.data || [];

    // Count edges by tipo_relacao
    const edges_by_type = {};
    for (const e of edges) {
      const t = e.tipo_relacao || 'unknown';
      edges_by_type[t] = (edges_by_type[t] || 0) + 1;
    }

    // Average strength
    const avg_strength = edges.length > 0
      ? Math.round((edges.reduce((sum, e) => sum + (e.strength || 0), 0) / edges.length) * 100) / 100
      : 0;

    // Top 10 most connected nodes (by counting appearances in edges)
    const connectionCount = {};
    for (const e of edges) {
      const srcKey = `${e.source_type}:${e.source_id}`;
      const tgtKey = `${e.target_type}:${e.target_id}`;
      connectionCount[srcKey] = (connectionCount[srcKey] || 0) + 1;
      connectionCount[tgtKey] = (connectionCount[tgtKey] || 0) + 1;
    }

    const topEntries = Object.entries(connectionCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => {
        const [type, id] = key.split(':');
        return { id, type, connections: count };
      });

    // Resolve labels for top connected
    const topResolved = await resolveNodeLabels(topEntries);
    const top_connected = topResolved.map(n => ({
      id: n.id,
      type: n.type,
      label: n.label,
      connections: topEntries.find(e => e.id === n.id && e.type === n.type)?.connections || 0
    }));

    logger.info('graph_stats', { nodes: Object.values(nodes_by_type).reduce((a, b) => a + b, 0), edges: edges.length });

    return res.json({
      success: true,
      nodes_by_type,
      edges_by_type,
      avg_strength,
      top_connected
    });
  } catch (err) {
    logger.error('graph_stats_error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Failed to load graph stats' });
  }
});

// ---------------------------------------------------------------------------
// GET /explore?q=cesla  - Graph exploration by company name or CNPJ
// 100% local DB — searches dim_empresas, fato_transacao_empresas, dim_noticias
// ---------------------------------------------------------------------------
router.get('/explore', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const entityType = req.query.entity_type ? String(req.query.entity_type) : null;
    const entityId = req.query.entity_id ? String(req.query.entity_id) : null;

    if (!entityId && (!q || q.length < 2)) {
      return res.status(400).json({ success: false, error: 'Query "q" must be at least 2 characters' });
    }

    // Detect if query is a CNPJ (digits only, 11-14 chars)
    const cleanDigits = q.replace(/[^\d]/g, '');
    const isCnpjQuery = cleanDigits.length >= 11 && cleanDigits.length <= 14 && /^\d+$/.test(cleanDigits);

    let localEmpresa = null;

    if (entityType === 'empresa' && entityId) {
      const { data } = await supabase
        .from('dim_empresas')
        .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral, cnae_descricao, porte, capital_social')
        .eq('id', entityId)
        .limit(1)
        .maybeSingle();
      localEmpresa = data;
    } else if (isCnpjQuery) {
      const cnpj = cleanDigits.padStart(14, '0');
      const { data } = await supabase
        .from('dim_empresas')
        .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral, cnae_descricao, porte, capital_social')
        .eq('cnpj', cnpj)
        .limit(1)
        .maybeSingle();
      localEmpresa = data;
    } else {
      const candidates = await searchCompaniesByName({ query: q, limit: 20 });
      if (candidates && candidates.length > 0) {
        // Fetch extra columns not returned by searchCompaniesByName
        const { data } = await supabase
          .from('dim_empresas')
          .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral, cnae_descricao, porte, capital_social')
          .eq('id', candidates[0].id)
          .maybeSingle();
        localEmpresa = data || candidates[0];
      }
    }

    if (!localEmpresa) {
      return res.json({ success: true, nodes: [], edges: [], center: null, stats: { total_nodes: 0, total_edges: 0, empresas: 0, socios: 0, noticias: 0 }, message: 'Nenhuma empresa encontrada' });
    }

    const empresaId = String(localEmpresa.id);
    const empresaLabel = localEmpresa.nome_fantasia || localEmpresa.razao_social || `CNPJ ${localEmpresa.cnpj}`;

    const nodes = [];
    const edges = [];
    let edgeId = 0;

    // Step 1: Add empresa as center node
    nodes.push({
      id: empresaId,
      type: 'empresa',
      label: empresaLabel,
      hop: 0,
      data: {
        cnpj: localEmpresa.cnpj,
        cidade: localEmpresa.cidade,
        estado: localEmpresa.estado,
        cnae: localEmpresa.cnae_descricao || null,
        porte: localEmpresa.porte || null,
        capital_social: localEmpresa.capital_social || null,
        situacao: localEmpresa.situacao_cadastral || null,
      }
    });

    // Step 2: Fetch sócios from fato_transacao_empresas + dim_pessoas
    const sociosMap = new Map();

    const { data: transacoes, error: txError } = await supabase
      .from('fato_transacao_empresas')
      .select(`
        pessoa_id,
        cargo,
        qualificacao,
        dim_pessoas (
          id,
          nome_completo,
          cargo_atual,
          empresa_atual
        )
      `)
      .eq('empresa_id', localEmpresa.id);

    if (txError) {
      logger.warn('explore_socios_error', { error: txError.message });
    }

    let transacoesNormalizadas = transacoes || [];

    // Fallback: when embedded dim_pessoas fails or comes sparse, resolve via pessoa_id directly.
    const missingPessoaRows = transacoesNormalizadas.filter((tx) => !tx.dim_pessoas?.id && tx.pessoa_id);
    if (missingPessoaRows.length > 0) {
      const pessoaIds = [...new Set(missingPessoaRows.map((tx) => String(tx.pessoa_id)).filter(Boolean))];
      const { data: pessoasFallback, error: pessoasFallbackError } = await supabase
        .from('dim_pessoas')
        .select('id, nome_completo, cargo_atual, empresa_atual')
        .in('id', pessoaIds);

      if (pessoasFallbackError) {
        logger.warn('explore_socios_fallback_error', { empresaId, error: pessoasFallbackError.message });
      } else {
        const pessoaLookup = new Map((pessoasFallback || []).map((p) => [String(p.id), p]));
        transacoesNormalizadas = transacoesNormalizadas.map((tx) => {
          if (tx.dim_pessoas?.id || !tx.pessoa_id) return tx;
          const fallbackPessoa = pessoaLookup.get(String(tx.pessoa_id));
          return fallbackPessoa ? { ...tx, dim_pessoas: fallbackPessoa } : tx;
        });
      }
    }

    for (const tx of transacoesNormalizadas) {
      const pessoa = tx.dim_pessoas;
      if (!pessoa || !pessoa.id) continue;
      const pessoaId = String(pessoa.id);
      if (sociosMap.has(pessoaId)) continue;

      sociosMap.set(pessoaId, {
        id: pessoaId,
        nome: pessoa.nome_completo,
        cargo: tx.cargo || tx.qualificacao || pessoa.cargo_atual
      });

      nodes.push({
        id: pessoaId,
        type: 'pessoa',
        label: pessoa.nome_completo || `Pessoa #${pessoaId}`,
        hop: 1,
        data: { cargo: tx.cargo || tx.qualificacao || pessoa.cargo_atual, empresa: pessoa.empresa_atual }
      });

      edges.push({
        id: `e${++edgeId}`,
        source: pessoaId,
        target: empresaId,
        tipo_relacao: 'societaria',
        strength: 0.9,
        label: tx.cargo || tx.qualificacao || 'Socio'
      });
    }

    // ---------------------------------------------------------------
    // Helper: count occurrences of a term in text (case-insensitive)
    // ---------------------------------------------------------------
    function countMentions(text, term) {
      if (!text || !term || term.length < 3) return 0;
      const lower = text.toLowerCase();
      const termLower = term.toLowerCase();
      let count = 0;
      let pos = 0;
      while ((pos = lower.indexOf(termLower, pos)) !== -1) {
        count++;
        pos += termLower.length;
      }
      return count;
    }

    // Collect all searchable names (hub + sócios) for cross-entity matching
    const hubNameLower = empresaLabel.toLowerCase();
    const allNodeNames = new Map(); // nodeId -> name (for inter-node edges later)
    allNodeNames.set(empresaId, empresaLabel);
    for (const [socioId, socio] of sociosMap) {
      if (socio.nome) allNodeNames.set(socioId, socio.nome);
    }

    // ---------------------------------------------------------------
    // Step 3: Search noticias mentioning hub name OR sócios names
    // ---------------------------------------------------------------
    const searchTerms = [empresaLabel];
    for (const [, socio] of sociosMap) {
      if (socio.nome && socio.nome.length >= 5) {
        searchTerms.push(socio.nome);
      }
    }

    const newsFilters = searchTerms
      .map(term => {
        const esc = `%${escapeLike(term)}%`;
        return `titulo.ilike.${esc},conteudo.ilike.${esc}`;
      })
      .join(',');

    const { data: noticias, error: newsError } = await supabase
      .from('dim_noticias')
      .select('id, titulo, fonte_nome, data_publicacao, conteudo')
      .or(newsFilters)
      .limit(30);

    if (newsError) {
      logger.warn('explore_news_error', { error: newsError.message, code: newsError.code });
    }

    // Track mention counts per node for strength normalization
    const mentionCounts = new Map(); // nodeId -> total mention count relative to hub

    // Add noticias nodes
    const noticiasAdded = new Set();

    for (const noticia of (noticias || [])) {
      const noticiaId = String(noticia.id);
      const fullText = `${noticia.titulo || ''} ${noticia.conteudo || ''}`;
      const textLower = fullText.toLowerCase();

      // Count direct hub name mentions
      const hubMentions = countMentions(fullText, empresaLabel);
      const mentionsEmpresa = hubMentions > 0;

      // Count sócio mentions
      const mentionedSocios = [];
      for (const [socioId, socio] of sociosMap) {
        if (socio.nome && textLower.includes(socio.nome.toLowerCase())) {
          mentionedSocios.push(socioId);
        }
      }

      if (!mentionsEmpresa && mentionedSocios.length === 0) continue;

      if (!noticiasAdded.has(noticiaId)) {
        noticiasAdded.add(noticiaId);
        mentionCounts.set(noticiaId, hubMentions);
        allNodeNames.set(noticiaId, noticia.titulo || '');
        nodes.push({
          id: noticiaId,
          type: 'noticia',
          label: (noticia.titulo || '').substring(0, 80),
          hop: 2,
          data: { fonte: noticia.fonte_nome, data_publicacao: noticia.data_publicacao, _text: fullText }
        });
      }

      if (mentionsEmpresa) {
        edges.push({
          id: `e${++edgeId}`,
          source: empresaId,
          target: noticiaId,
          tipo_relacao: 'mencionado_em',
          strength: 0, // will be normalized below
          label: `${hubMentions}x mencionado`
        });
      }

      for (const socioId of mentionedSocios) {
        edges.push({
          id: `e${++edgeId}`,
          source: socioId,
          target: noticiaId,
          tipo_relacao: 'mencionado_em',
          strength: 0, // will be normalized below
          label: 'Mencionado'
        });
      }
    }

    // ---------------------------------------------------------------
    // Step 4: Search politicos from brasilDataHub
    // ---------------------------------------------------------------
    let politicosAdded = 0;
    let mandatosAdded = 0;
    let emendasAdded = 0;

    if (brasilDataHub) {
      const hubEsc = `%${escapeLike(empresaLabel)}%`;
      const cidadeEsc = localEmpresa.cidade ? `%${escapeLike(localEmpresa.cidade)}%` : null;

      // 4a: Emendas that mention hub name or cidade in descricao/localidade
      const emendasFilters = [`autor.ilike.${hubEsc}`, `descricao.ilike.${hubEsc}`];
      if (cidadeEsc) {
        emendasFilters.push(`localidade.ilike.${cidadeEsc}`);
      }

      const { data: emendas, error: emErr } = await brasilDataHub
        .from('fato_emendas_parlamentares')
        .select('id, autor, descricao, localidade, uf, ano, tipo, valor_empenhado')
        .or(emendasFilters.join(','))
        .limit(20);

      if (emErr) {
        logger.warn('explore_emendas_error', { error: emErr.message });
      }

      const politicoAutors = new Set();

      for (const emenda of (emendas || [])) {
        const emendaId = `emenda_${emenda.id}`;
        const emendaText = `${emenda.autor || ''} ${emenda.descricao || ''} ${emenda.localidade || ''}`;
        const hubMentions = countMentions(emendaText, empresaLabel);

        mentionCounts.set(emendaId, hubMentions);
        allNodeNames.set(emendaId, emenda.autor || '');

        nodes.push({
          id: emendaId,
          type: 'emenda',
          label: `${(emenda.autor || '').substring(0, 30)} - ${emenda.tipo || 'Emenda'} ${emenda.ano || ''}`,
          hop: 2,
          data: {
            autor: emenda.autor,
            tipo: emenda.tipo,
            ano: emenda.ano,
            uf: emenda.uf,
            valor: emenda.valor_empenhado,
            localidade: emenda.localidade,
            _text: emendaText
          }
        });

        edges.push({
          id: `e${++edgeId}`,
          source: empresaId,
          target: emendaId,
          tipo_relacao: 'emenda_beneficiario',
          strength: 0,
          label: hubMentions > 0 ? `${hubMentions}x mencionado` : emenda.localidade || ''
        });

        if (emenda.autor) politicoAutors.add(emenda.autor);
        emendasAdded++;
      }

      // 4b: Politicos who authored connected emendas
      if (politicoAutors.size > 0) {
        const autorFilters = [...politicoAutors]
          .map(a => {
            const e = `%${escapeLike(a)}%`;
            return `nome_completo.ilike.${e},nome_urna.ilike.${e}`;
          })
          .join(',');

        const { data: politicos, error: polErr } = await brasilDataHub
          .from('dim_politicos')
          .select('id, nome_completo, nome_urna, partido_sigla, cargo_atual')
          .or(autorFilters)
          .limit(20);

        if (polErr) {
          logger.warn('explore_politicos_error', { error: polErr.message });
        }

        const politicoIds = new Map(); // nome -> id

        for (const pol of (politicos || [])) {
          const polId = `pol_${pol.id}`;
          const polName = pol.nome_urna || pol.nome_completo;
          politicoIds.set(polName, polId);
          allNodeNames.set(polId, polName);

          // Count how many times politico name appears in hub-related content
          let polMentions = 0;
          for (const noticia of (noticias || [])) {
            const text = `${noticia.titulo || ''} ${noticia.conteudo || ''}`;
            polMentions += countMentions(text, polName);
          }
          mentionCounts.set(polId, polMentions);

          nodes.push({
            id: polId,
            type: 'politico',
            label: polName,
            hop: 2,
            data: { partido: pol.partido_sigla, cargo: pol.cargo_atual }
          });

          // Connect politico to hub
          edges.push({
            id: `e${++edgeId}`,
            source: polId,
            target: empresaId,
            tipo_relacao: 'politico_empresarial',
            strength: 0,
            label: pol.partido_sigla || ''
          });

          // Connect politico to their emendas
          for (const emenda of (emendas || [])) {
            if (emenda.autor && (
              emenda.autor.toLowerCase().includes(polName.toLowerCase()) ||
              polName.toLowerCase().includes(emenda.autor.toLowerCase())
            )) {
              edges.push({
                id: `e${++edgeId}`,
                source: polId,
                target: `emenda_${emenda.id}`,
                tipo_relacao: 'societaria',
                strength: 1.0,
                label: 'Autor'
              });
            }
          }
          politicosAdded++;
        }

        // 4c: Mandatos for found politicos
        if (politicos && politicos.length > 0) {
          const polIds = politicos.map(p => p.id);
          const { data: mandatos, error: mandErr } = await brasilDataHub
            .from('fato_politicos_mandatos')
            .select('id, cargo, partido_sigla, partido_nome, municipio, codigo_ibge, ano_eleicao, eleito, politico_id')
            .in('politico_id', polIds)
            .limit(30);

          if (mandErr) {
            logger.warn('explore_mandatos_error', { error: mandErr.message });
          }

          for (const mandato of (mandatos || [])) {
            const mandatoId = `mandato_${mandato.id}`;
            const mandatoLabel = `${mandato.cargo || 'Mandato'} ${mandato.municipio || ''} ${mandato.ano_eleicao || ''}`;
            allNodeNames.set(mandatoId, mandatoLabel);

            // Check if mandato municipality matches empresa cidade
            const municipioMatch = mandato.municipio && localEmpresa.cidade &&
              mandato.municipio.toLowerCase().includes(localEmpresa.cidade.toLowerCase());
            mentionCounts.set(mandatoId, municipioMatch ? 2 : 0);

            nodes.push({
              id: mandatoId,
              type: 'mandato',
              label: mandatoLabel.substring(0, 60),
              hop: 3,
              data: {
                cargo: mandato.cargo,
                municipio: mandato.municipio,
                ano: mandato.ano_eleicao,
                eleito: mandato.eleito,
                partido: mandato.partido_sigla
              }
            });

            // Connect mandato to its politico
            const parentPolId = `pol_${mandato.politico_id}`;
            if (nodes.some(n => n.id === parentPolId)) {
              edges.push({
                id: `e${++edgeId}`,
                source: parentPolId,
                target: mandatoId,
                tipo_relacao: 'societaria',
                strength: 1.0,
                label: mandato.partido_sigla || ''
              });
            }

            // If municipio matches, also connect to hub
            if (municipioMatch) {
              edges.push({
                id: `e${++edgeId}`,
                source: empresaId,
                target: mandatoId,
                tipo_relacao: 'mencionado_em',
                strength: 0,
                label: mandato.municipio || ''
              });
            }
            mandatosAdded++;
          }
        }
      }
    }

    // ---------------------------------------------------------------
    // Step 5: Normalize strengths based on mention counts
    // ---------------------------------------------------------------
    // Sócios always get strength 1.0 (direct relationship)
    // Other nodes: normalize mentions relative to max mentions
    const mentionValues = [...mentionCounts.values()].filter(v => v > 0);
    const maxMentions = mentionValues.length > 0 ? Math.max(...mentionValues) : 1;

    // Build node strength map (nodeId -> normalized strength 0-1)
    const nodeStrengthMap = new Map();

    // Sócios = direct reference = super strong
    for (const [socioId] of sociosMap) {
      nodeStrengthMap.set(socioId, 1.0);
    }

    // All other nodes: normalize by mention count
    for (const [nodeId, mentions] of mentionCounts) {
      if (nodeStrengthMap.has(nodeId)) continue;
      if (mentions > 0) {
        // Range: 0.2 (1 mention) to 0.95 (max mentions)
        nodeStrengthMap.set(nodeId, 0.2 + 0.75 * (mentions / maxMentions));
      } else {
        // No direct mention but still connected (e.g. through location)
        nodeStrengthMap.set(nodeId, 0.1);
      }
    }

    // Apply normalized strengths to edges connected to hub
    for (const edge of edges) {
      if (edge.strength !== 0) continue; // skip already-set edges (e.g. autor=1.0)
      const src = String(edge.source);
      const tgt = String(edge.target);
      const otherNodeId = src === empresaId ? tgt : (tgt === empresaId ? src : null);
      if (otherNodeId) {
        edge.strength = nodeStrengthMap.get(otherNodeId) || 0.3;
      } else {
        // Inter-node edge: use average of both nodes' strengths
        const s1 = nodeStrengthMap.get(src) || 0.3;
        const s2 = nodeStrengthMap.get(tgt) || 0.3;
        edge.strength = (s1 + s2) / 2;
      }
    }

    // Also update sócio edge strengths
    for (const edge of edges) {
      if (edge.tipo_relacao === 'societaria' && edge.strength === 0.9) {
        edge.strength = 1.0;
      }
    }

    // ---------------------------------------------------------------
    // Step 6: Inter-node edges (dot-to-dot connections)
    // ---------------------------------------------------------------
    const nonHubNodes = nodes.filter(n => n.id !== empresaId);
    const existingEdgePairs = new Set(edges.map(e => `${e.source}::${e.target}`));

    for (let i = 0; i < nonHubNodes.length; i++) {
      for (let j = i + 1; j < nonHubNodes.length; j++) {
        const a = nonHubNodes[i];
        const b = nonHubNodes[j];

        const pairKey1 = `${a.id}::${b.id}`;
        const pairKey2 = `${b.id}::${a.id}`;
        if (existingEdgePairs.has(pairKey1) || existingEdgePairs.has(pairKey2)) continue;

        const aName = allNodeNames.get(a.id) || '';
        const bName = allNodeNames.get(b.id) || '';
        const aText = (a.data?._text || a.label || '').toLowerCase();
        const bText = (b.data?._text || b.label || '').toLowerCase();

        // Check if A's name appears in B's text or vice versa
        const aMentionsB = bName.length >= 4 && countMentions(aText, bName);
        const bMentionsA = aName.length >= 4 && countMentions(bText, aName);
        const totalMentions = aMentionsB + bMentionsA;

        if (totalMentions > 0) {
          const interStrength = Math.min(0.95, 0.2 + 0.75 * (totalMentions / Math.max(maxMentions, 1)));
          edges.push({
            id: `e${++edgeId}`,
            source: a.id,
            target: b.id,
            tipo_relacao: 'mencionado_em',
            strength: interStrength,
            label: `${totalMentions}x ref`
          });
          existingEdgePairs.add(pairKey1);
        }
      }
    }

    // Clean up internal _text field before sending response
    for (const node of nodes) {
      if (node.data?._text) delete node.data._text;
    }

    // ---------------------------------------------------------------
    // Step 7: Return response
    // ---------------------------------------------------------------
    const stats = {
      total_nodes: nodes.length,
      total_edges: edges.length,
      empresas: 1,
      socios: sociosMap.size,
      noticias: noticiasAdded.size,
      politicos: politicosAdded,
      emendas: emendasAdded,
      mandatos: mandatosAdded
    };

    logger.info('graph_explore', { query: q, ...stats });

    const nodeTypeById = new Map(nodes.map((node) => [String(node.id), node.type]));

    const responseNodes = nodes.map((node) => ({
      id: makeGraphNodeId(node.type, node.id),
      type: node.type,
      label: node.label,
      data: {
        ...(node.data || {}),
        hop: node.hop,
        entityId: String(node.id),
      }
    }));

    const responseEdges = edges.map((edge) => ({
      ...edge,
      source: makeGraphNodeId(nodeTypeById.get(String(edge.source)) || 'unknown', edge.source),
      target: makeGraphNodeId(nodeTypeById.get(String(edge.target)) || 'unknown', edge.target),
    }));

    return res.json({
      success: true,
      nodes: responseNodes,
      edges: responseEdges,
      center: { id: makeGraphNodeId('empresa', empresaId), type: 'empresa', label: empresaLabel },
      stats
    });
  } catch (err) {
    logger.error('graph_explore_error', { query: req.query.q, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Explore failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /node-details/empresa/:empresaId  — Full empresa details for sidebar
// Joins dim_empresas + fato_regime_tributario + raw_cnae + socios
// ---------------------------------------------------------------------------
router.get('/node-details/empresa/:empresaId', async (req, res) => {
  try {
    const empresaId = getRawEntityId(req.params.empresaId);
    if (!empresaId) {
      return res.status(400).json({ success: false, error: 'empresa_id is required' });
    }

    // 1. dim_empresas (select * to avoid column mismatch issues)
    const { data: empresa, error: e1 } = await supabase
      .from('dim_empresas')
      .select('*')
      .eq('id', empresaId)
      .maybeSingle();

    if (e1 || !empresa) {
      logger.warn('graph_node_details_not_found', { empresaId, error: e1?.message });
      return res.status(404).json({ success: false, error: 'Empresa not found' });
    }

    // 2. fato_regime_tributario (all records, ordered by date)
    const { data: regimes, error: e2 } = await supabase
      .from('fato_regime_tributario')
      .select('*')
      .eq('empresa_id', empresaId)
      .order('data_registro', { ascending: false });

    if (e2) {
      logger.warn('graph_node_details_regime_error', { empresaId, error: e2.message });
    }

    const activeRegime = (regimes || []).find(r => r.ativo) || (regimes || [])[0] || null;

    // 3. raw_cnae lookup — try cnae_id FK first, then code match
    let cnaeDetails = null;
    if (empresa.cnae_id) {
      const { data: cnae } = await supabase
        .from('raw_cnae')
        .select('codigo, descricao, secao, descricao_secao, divisao, descricao_divisao, grupo, descricao_grupo, classe, descricao_classe')
        .eq('id', empresa.cnae_id)
        .maybeSingle();
      cnaeDetails = cnae || null;
    }
    if (!cnaeDetails) {
      const cnaeCode = activeRegime?.cnae_principal || empresa.cnae_principal || empresa.cnae_descricao;
      if (cnaeCode) {
        const cleanCode = cnaeCode.replace(/[.\-/]/g, '');
        const { data: cnae } = await supabase
          .from('raw_cnae')
          .select('codigo, descricao, secao, descricao_secao, divisao, descricao_divisao, grupo, descricao_grupo, classe, descricao_classe')
          .or(`codigo_numerico.eq.${cleanCode},codigo.eq.${cnaeCode}`)
          .limit(1)
          .maybeSingle();
        cnaeDetails = cnae || null;
      }
    }

    // 4. Socios (fato_transacao_empresas → dim_pessoas via embedded join)
    const { data: transacoes, error: e3 } = await supabase
      .from('fato_transacao_empresas')
      .select(`
        cargo,
        qualificacao,
        data_transacao,
        dim_pessoas (
          id,
          nome_completo,
          primeiro_nome,
          sobrenome,
          cpf,
          email,
          linkedin_url,
          foto_url,
          faixa_etaria
        )
      `)
      .eq('empresa_id', empresaId);

    if (e3) {
      logger.warn('graph_node_details_socios_error', { empresaId, error: e3.message });
    }

    let socios = [];
    if (transacoes && transacoes.length > 0) {
      for (const tx of transacoes) {
        const p = tx.dim_pessoas;
        if (!p || !p.id) continue;
        socios.push({
          nome: p.nome_completo || [p.primeiro_nome, p.sobrenome].filter(Boolean).join(' ') || `Pessoa #${p.id}`,
          cpf: p.cpf,
          cargo: tx.cargo || tx.qualificacao,
          qualificacao: tx.qualificacao,
          email: p.email,
          linkedin: p.linkedin_url,
          foto_url: p.foto_url,
          faixa_etaria: p.faixa_etaria,
          data_entrada: tx.data_transacao,
        });
      }
    }

    logger.info('graph_node_details', { empresaId, regimes: (regimes || []).length, socios: socios.length });

    return res.json({
      success: true,
      empresa,
      regime: activeRegime,
      regimes: regimes || [],
      cnae: cnaeDetails,
      socios,
    });
  } catch (err) {
    logger.error('graph_node_details_error', { empresaId: req.params.empresaId, error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to fetch node details' });
  }
});

// ---------------------------------------------------------------------------
// SOURCE RELIABILITY WEIGHTS — Bayesian evidence model
// ---------------------------------------------------------------------------
const SOURCE_WEIGHTS = {
  fato_transacao_empresas: 1.0,
  dim_empresas: 0.95,
  dim_pessoas: 0.9,
  dim_politicos: 0.9,
  fato_politicos_mandatos: 0.85,
  fato_emendas: 0.85,
  fato_bens_candidato: 0.8,
  fato_receitas_campanha: 0.8,
  fato_votos_legislativos: 0.8,
  dim_noticias: 0.5,
  fato_noticias_topicos: 0.4,
  vw_noticias_completas: 0.5,
};

const RELATION_EVIDENCE_WEIGHTS = {
  contrato_social: 1.0,
  database: 0.85,
  eleicao: 0.85,
  cross_reference: 0.4,
};

const SOURCE_CATEGORY = {
  dim_empresas: 'empresa',
  dim_pessoas: 'pessoa',
  dim_politicos: 'politico',
  fato_politicos_mandatos: 'mandato',
  fato_emendas: 'emenda',
  dim_noticias: 'noticia',
  fato_noticias_topicos: 'noticia',
  vw_noticias_completas: 'noticia',
  fato_transacao_empresas: 'pessoa',
  fato_bens_candidato: 'politico',
  fato_receitas_campanha: 'politico',
  fato_votos_legislativos: 'politico',
};

function bayesianConfidence(weights) {
  if (!weights || weights.length === 0) return 0;
  let product = 1;
  for (const w of weights) product *= 1 - w;
  return Math.round((1 - product) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// GET /deep-search?q=<term>  — Cross-table deep search with relevance scoring
// ---------------------------------------------------------------------------
router.get('/deep-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ success: false, error: 'Query "q" must be at least 2 characters' });
    }

    const escaped = escapeLike(q);
    const pattern = `%${escaped}%`;
    const resultMap = new Map();
    const linkMap = new Map();

    function addResult(key, { id, type, label, subtitle, source, weight, data }) {
      if (resultMap.has(key)) {
        const existing = resultMap.get(key);
        existing.sources.push({ table: source, weight });
        if (data) Object.assign(existing.data, data);
      } else {
        resultMap.set(key, {
          id: String(id), type,
          label: label || `${type} #${id}`,
          subtitle: subtitle || '',
          sources: [{ table: source, weight }],
          data: data || {},
        });
      }
    }

    function addLink(srcKey, tgtKey, tipo_relacao, evidence, weight = RELATION_EVIDENCE_WEIGHTS[evidence] || 0.5) {
      const k = `${srcKey}::${tgtKey}`;
      const r = `${tgtKey}::${srcKey}`;
      const existingKey = linkMap.has(k) ? k : (linkMap.has(r) ? r : null);

      if (existingKey) {
        const existing = linkMap.get(existingKey);
        if (!existing.evidences.some(item => item.label === evidence)) {
          existing.evidences.push({ label: evidence, weight });
        }
        if (existing.tipo_relacao === 'mencionado_em' && tipo_relacao !== 'mencionado_em') {
          existing.tipo_relacao = tipo_relacao;
        }
        return;
      }

      linkMap.set(k, {
        source: srcKey,
        target: tgtKey,
        tipo_relacao,
        evidences: [{ label: evidence, weight }],
      });
    }

    const searchPromises = [];

    // 1. dim_empresas
    searchPromises.push(
      supabase.from('dim_empresas')
        .select('id, razao_social, nome_fantasia, cnpj, cidade, estado, situacao_cadastral, email, website')
        .or(`razao_social.ilike.${pattern},nome_fantasia.ilike.${pattern},cnpj.ilike.${pattern},email.ilike.${pattern},website.ilike.${pattern}`)
        .limit(50)
        .then(({ data }) => {
          for (const e of (data || [])) {
            addResult(`empresa:${e.id}`, {
              id: e.id, type: 'empresa',
              label: e.nome_fantasia || e.razao_social,
              subtitle: [e.cnpj, e.cidade, e.estado].filter(Boolean).join(' - '),
              source: 'dim_empresas', weight: SOURCE_WEIGHTS.dim_empresas,
              data: { cnpj: e.cnpj, cidade: e.cidade, estado: e.estado, situacao: e.situacao_cadastral },
            });
          }
        })
    );

    // 2. dim_pessoas
    searchPromises.push(
      supabase.from('dim_pessoas')
        .select('id, nome_completo, email, linkedin_url, cargo_atual, empresa_atual')
        .or(`nome_completo.ilike.${pattern},email.ilike.${pattern}`)
        .limit(50)
        .then(({ data }) => {
          for (const p of (data || [])) {
            addResult(`pessoa:${p.id}`, {
              id: p.id, type: 'pessoa',
              label: p.nome_completo,
              subtitle: [p.cargo_atual, p.empresa_atual].filter(Boolean).join(' @ '),
              source: 'dim_pessoas', weight: SOURCE_WEIGHTS.dim_pessoas,
              data: { email: p.email, linkedin: p.linkedin_url, cargo: p.cargo_atual },
            });
          }
        })
    );

    // 3. fato_transacao_empresas (join dim_pessoas)
    searchPromises.push(
      supabase.from('fato_transacao_empresas')
        .select('id, cargo, qualificacao, empresa_id, dim_pessoas!inner ( id, nome_completo, email, linkedin_url )')
        .ilike('dim_pessoas.nome_completo', pattern)
        .limit(50)
        .then(({ data }) => {
          for (const tx of (data || [])) {
            const p = tx.dim_pessoas;
            if (!p || !p.id) continue;
            const pk = `pessoa:${p.id}`;
            addResult(pk, {
              id: p.id, type: 'pessoa', label: p.nome_completo,
              subtitle: tx.cargo || tx.qualificacao || '',
              source: 'fato_transacao_empresas', weight: SOURCE_WEIGHTS.fato_transacao_empresas,
              data: { email: p.email, linkedin: p.linkedin_url, cargo: tx.cargo || tx.qualificacao },
            });
            if (tx.empresa_id) addLink(pk, `empresa:${tx.empresa_id}`, 'societaria', 'contrato_social');
          }
        })
    );

    // 4. dim_noticias
    searchPromises.push(
      supabase.from('dim_noticias')
        .select('id, titulo, resumo, fonte_nome, data_publicacao')
        .or(`titulo.ilike.${pattern},resumo.ilike.${pattern}`)
        .limit(30)
        .then(({ data }) => {
          for (const n of (data || [])) {
            addResult(`noticia:${n.id}`, {
              id: n.id, type: 'noticia',
              label: (n.titulo || '').substring(0, 80),
              subtitle: [n.fonte_nome, n.data_publicacao].filter(Boolean).join(' - '),
              source: 'dim_noticias', weight: SOURCE_WEIGHTS.dim_noticias,
              data: { fonte: n.fonte_nome, data: n.data_publicacao },
            });
          }
        })
    );

    // 5. fato_noticias_topicos
    searchPromises.push(
      supabase.from('fato_noticias_topicos')
        .select('id, noticia_id, topico, relevancia, sentimento')
        .ilike('topico', pattern)
        .limit(30)
        .then(({ data }) => {
          for (const t of (data || [])) {
            if (t.noticia_id) {
              addResult(`noticia:${t.noticia_id}`, {
                id: t.noticia_id, type: 'noticia', label: t.topico,
                subtitle: `Topico: ${t.sentimento || ''} (rel: ${t.relevancia || 0})`,
                source: 'fato_noticias_topicos', weight: SOURCE_WEIGHTS.fato_noticias_topicos,
                data: { topico: t.topico, sentimento: t.sentimento },
              });
            }
          }
        })
    );

    // 6. fato_bens_candidato
    searchPromises.push(
      supabase.from('fato_bens_candidato').select('*')
        .or(`descricao.ilike.${pattern},tipo_bem.ilike.${pattern},candidato_nome.ilike.${pattern}`)
        .limit(30)
        .then(({ data }) => {
          for (const b of (data || [])) {
            addResult(`bens:${b.id}`, {
              id: b.id, type: 'politico',
              label: (b.candidato_nome || b.descricao || `Bem #${b.id}`).substring(0, 80),
              subtitle: [b.tipo_bem, b.valor ? `R$ ${Number(b.valor).toLocaleString('pt-BR')}` : null, b.ano_eleicao].filter(Boolean).join(' - '),
              source: 'fato_bens_candidato', weight: SOURCE_WEIGHTS.fato_bens_candidato,
              data: b,
            });
          }
        }).catch(err => logger.warn('deep_search_bens_error', { error: err.message }))
    );

    // 7. fato_receitas_campanha
    searchPromises.push(
      supabase.from('fato_receitas_campanha').select('*')
        .or(`doador_nome.ilike.${pattern},candidato_nome.ilike.${pattern},descricao.ilike.${pattern}`)
        .limit(30)
        .then(({ data }) => {
          for (const r of (data || [])) {
            addResult(`receita:${r.id}`, {
              id: r.id, type: 'politico',
              label: (r.candidato_nome || r.doador_nome || `Receita #${r.id}`).substring(0, 80),
              subtitle: [r.doador_nome, r.valor ? `R$ ${Number(r.valor).toLocaleString('pt-BR')}` : null, r.ano_eleicao].filter(Boolean).join(' - '),
              source: 'fato_receitas_campanha', weight: SOURCE_WEIGHTS.fato_receitas_campanha,
              data: r,
            });
          }
        }).catch(err => logger.warn('deep_search_receitas_error', { error: err.message }))
    );

    // 8. fato_votos_legislativos
    searchPromises.push(
      supabase.from('fato_votos_legislativos').select('*')
        .or(`parlamentar_nome.ilike.${pattern},materia.ilike.${pattern},descricao.ilike.${pattern}`)
        .limit(30)
        .then(({ data }) => {
          for (const v of (data || [])) {
            addResult(`voto:${v.id}`, {
              id: v.id, type: 'politico',
              label: (v.parlamentar_nome || v.materia || `Voto #${v.id}`).substring(0, 80),
              subtitle: [v.voto, v.sessao, v.data_sessao].filter(Boolean).join(' - '),
              source: 'fato_votos_legislativos', weight: SOURCE_WEIGHTS.fato_votos_legislativos,
              data: v,
            });
          }
        }).catch(err => logger.warn('deep_search_votos_error', { error: err.message }))
    );

    // 9-10. Brasil Data Hub
    if (brasilDataHub) {
      searchPromises.push(
        brasilDataHub.from('dim_politicos')
          .select('id, nome_completo, nome_urna, partido_sigla, cargo_atual')
          .or(`nome_completo.ilike.${pattern},nome_urna.ilike.${pattern}`)
          .limit(30)
          .then(({ data }) => {
            for (const pol of (data || [])) {
              addResult(`politico:${pol.id}`, {
                id: pol.id, type: 'politico',
                label: pol.nome_urna || pol.nome_completo,
                subtitle: [pol.partido_sigla, pol.cargo_atual].filter(Boolean).join(' - '),
                source: 'dim_politicos', weight: SOURCE_WEIGHTS.dim_politicos,
                data: { partido: pol.partido_sigla, cargo: pol.cargo_atual },
              });
            }
          }),
        brasilDataHub.from('fato_emendas_parlamentares')
          .select('id, autor, descricao, localidade, uf, ano, tipo, valor_empenhado')
          .or(`autor.ilike.${pattern},descricao.ilike.${pattern},localidade.ilike.${pattern}`)
          .limit(30)
          .then(({ data }) => {
            for (const em of (data || [])) {
              addResult(`emenda:${em.id}`, {
                id: em.id, type: 'emenda',
                label: `${(em.autor || '').substring(0, 30)} - ${em.tipo || 'Emenda'} ${em.ano || ''}`,
                subtitle: [em.localidade, em.uf, em.valor_empenhado ? `R$ ${Number(em.valor_empenhado).toLocaleString('pt-BR')}` : null].filter(Boolean).join(' - '),
                source: 'fato_emendas', weight: SOURCE_WEIGHTS.fato_emendas,
                data: { autor: em.autor, tipo: em.tipo, ano: em.ano, uf: em.uf, valor: em.valor_empenhado },
              });
            }
          }),
        brasilDataHub.from('fato_politicos_mandatos')
          .select('id, politico_id, cargo, partido_sigla, municipio, ano_eleicao, eleito')
          .or(`municipio.ilike.${pattern},cargo.ilike.${pattern}`)
          .limit(30)
          .then(({ data }) => {
            for (const m of (data || [])) {
              const key = `mandato:${m.id}`;
              addResult(key, {
                id: m.id, type: 'mandato',
                label: `${m.cargo || 'Mandato'} ${m.municipio || ''} ${m.ano_eleicao || ''}`.substring(0, 60),
                subtitle: [m.partido_sigla, m.eleito ? 'Eleito' : 'Nao eleito', m.ano_eleicao].filter(Boolean).join(' - '),
                source: 'fato_politicos_mandatos', weight: SOURCE_WEIGHTS.fato_politicos_mandatos,
                data: { cargo: m.cargo, municipio: m.municipio, ano: m.ano_eleicao, partido: m.partido_sigla, eleito: m.eleito },
              });
              if (m.politico_id) addLink(key, `politico:${m.politico_id}`, 'mandato', 'eleicao');
            }
          })
      );
    }

    await Promise.allSettled(searchPromises);

    // ── Fetch REAL relationships from fato_relacoes_entidades ──
    // Group discovered node IDs by entity type so we can query existing DB edges
    const idsByType = {};
    for (const [key] of resultMap) {
      const [type, id] = key.split(':');
      if (!idsByType[type]) idsByType[type] = [];
      idsByType[type].push(id);
    }

    // Build OR conditions for all discovered entity types
    const orClauses = [];
    for (const [type, ids] of Object.entries(idsByType)) {
      if (ids.length > 0) {
        orClauses.push(`and(source_type.eq.${type},source_id.in.(${ids.join(',')}))`);
        orClauses.push(`and(target_type.eq.${type},target_id.in.(${ids.join(',')}))`);
      }
    }

    if (orClauses.length > 0) {
      const { data: dbEdges, error: dbEdgesErr } = await supabase
        .from('fato_relacoes_entidades')
        .select('source_type, source_id, target_type, target_id, tipo_relacao, strength')
        .eq('ativo', true)
        .or(orClauses.join(','))
        .limit(500);

      if (!dbEdgesErr && dbEdges) {
        for (const edge of dbEdges) {
          const srcKey = `${edge.source_type}:${edge.source_id}`;
          const tgtKey = `${edge.target_type}:${edge.target_id}`;

          // Only add edge if BOTH endpoints are in our discovered resultMap
          if (resultMap.has(srcKey) && resultMap.has(tgtKey)) {
            addLink(
              srcKey,
              tgtKey,
              edge.tipo_relacao,
              'database',
              Math.max(Number(edge.strength) || 0, RELATION_EVIDENCE_WEIGHTS.database)
            );
          }

          // Also discover nodes connected to our results but not yet in resultMap
          // This brings in relationship context (e.g. a pessoa linked to a discovered empresa)
          const missingKey = !resultMap.has(srcKey) ? srcKey : (!resultMap.has(tgtKey) ? tgtKey : null);
          if (missingKey) {
            const [mType, mId] = missingKey.split(':');
            // Only add 1-hop neighbor nodes (not discovered by search, but linked to results)
            const presentKey = missingKey === srcKey ? tgtKey : srcKey;
            if (resultMap.has(presentKey)) {
              // We don't have this node yet — add a placeholder, will be resolved below
              addResult(missingKey, {
                id: mId, type: mType,
                label: `${mType} #${mId}`,
                subtitle: 'Conexão descoberta',
                source: 'fato_relacoes_entidades', weight: 0.7,
                data: { discovered_via: 'relationship' },
              });
              addLink(
                presentKey,
                missingKey,
                edge.tipo_relacao,
                'database',
                Math.max(Number(edge.strength) || 0, RELATION_EVIDENCE_WEIGHTS.database)
              );
            }
          }
        }

        // Resolve labels for placeholder nodes (discovered via relationships)
        const placeholders = [...resultMap.entries()].filter(([, v]) => v.label.includes('#') && v.data.discovered_via === 'relationship');
        if (placeholders.length > 0) {
          const resolveByType = {};
          for (const [key, node] of placeholders) {
            if (!resolveByType[node.type]) resolveByType[node.type] = [];
            resolveByType[node.type].push({ key, id: node.id });
          }

          const resolvePromises = [];

          if (resolveByType.empresa?.length > 0) {
            resolvePromises.push(
              supabase.from('dim_empresas')
                .select('id, razao_social, nome_fantasia, cnpj, cidade, estado')
                .in('id', resolveByType.empresa.map(n => n.id))
                .then(({ data }) => {
                  for (const e of (data || [])) {
                    const node = resultMap.get(`empresa:${e.id}`);
                    if (node) {
                      node.label = e.nome_fantasia || e.razao_social || node.label;
                      node.subtitle = [e.cnpj, e.cidade, e.estado].filter(Boolean).join(' - ');
                      Object.assign(node.data, { cnpj: e.cnpj, cidade: e.cidade, estado: e.estado });
                    }
                  }
                })
            );
          }

          if (resolveByType.pessoa?.length > 0) {
            resolvePromises.push(
              supabase.from('dim_pessoas')
                .select('id, nome_completo, cargo_atual, empresa_atual')
                .in('id', resolveByType.pessoa.map(n => n.id))
                .then(({ data }) => {
                  for (const p of (data || [])) {
                    const node = resultMap.get(`pessoa:${p.id}`);
                    if (node) {
                      node.label = p.nome_completo || node.label;
                      node.subtitle = [p.cargo_atual, p.empresa_atual].filter(Boolean).join(' @ ');
                    }
                  }
                })
            );
          }

          if (resolveByType.politico?.length > 0) {
            resolvePromises.push(
              supabase.from('dim_politicos')
                .select('id, nome_completo, partido_sigla, cargo_atual')
                .in('id', resolveByType.politico.map(n => n.id))
                .then(({ data }) => {
                  for (const p of (data || [])) {
                    const node = resultMap.get(`politico:${p.id}`);
                    if (node) {
                      node.label = p.nome_completo || node.label;
                      node.subtitle = [p.partido_sigla, p.cargo_atual].filter(Boolean).join(' - ');
                    }
                  }
                })
            );
          }

          if (resolveByType.noticia?.length > 0) {
            resolvePromises.push(
              supabase.from('dim_noticias')
                .select('id, titulo, fonte_nome')
                .in('id', resolveByType.noticia.map(n => n.id))
                .then(({ data }) => {
                  for (const n of (data || [])) {
                    const node = resultMap.get(`noticia:${n.id}`);
                    if (node) {
                      node.label = (n.titulo || '').substring(0, 80) || node.label;
                      node.subtitle = n.fonte_nome || '';
                    }
                  }
                })
            );
          }

          await Promise.allSettled(resolvePromises);
        }
      }

      logger.info('deep_search_db_edges', {
        query: q,
        orClauses: orClauses.length,
        dbEdgesFound: dbEdges?.length || 0,
        linkMapSize: linkMap.size,
      });
    }

    // ── Resolve missing link endpoints (from search-phase links like societaria) ──
    // Some links reference nodes not found by the search (e.g. empresa linked to a pessoa via fato_transacao)
    const missingLinkEndpoints = new Map();
    for (const [, link] of linkMap) {
      for (const endpoint of [link.source, link.target]) {
        if (!resultMap.has(endpoint)) {
          const [mType, mId] = endpoint.split(':');
          if (mType && mId) missingLinkEndpoints.set(endpoint, { type: mType, id: mId });
        }
      }
    }

    if (missingLinkEndpoints.size > 0) {
      // Add placeholder nodes for missing endpoints
      for (const [key, { type, id }] of missingLinkEndpoints) {
        addResult(key, {
          id, type,
          label: `${type} #${id}`,
          subtitle: 'Conexão descoberta',
          source: 'fato_relacoes_entidades', weight: 0.7,
          data: { discovered_via: 'relationship' },
        });
      }

      // Resolve labels for these placeholder nodes
      const resolveByType2 = {};
      for (const [, { type, id }] of missingLinkEndpoints) {
        if (!resolveByType2[type]) resolveByType2[type] = [];
        resolveByType2[type].push(id);
      }

      const resolvePromises2 = [];

      if (resolveByType2.empresa?.length > 0) {
        resolvePromises2.push(
          supabase.from('dim_empresas')
            .select('id, razao_social, nome_fantasia, cnpj, cidade, estado')
            .in('id', resolveByType2.empresa)
            .then(({ data }) => {
              for (const e of (data || [])) {
                const node = resultMap.get(`empresa:${e.id}`);
                if (node) {
                  node.label = e.nome_fantasia || e.razao_social || node.label;
                  node.subtitle = [e.cnpj, e.cidade, e.estado].filter(Boolean).join(' - ');
                  Object.assign(node.data, { cnpj: e.cnpj, cidade: e.cidade, estado: e.estado });
                }
              }
            })
        );
      }

      if (resolveByType2.pessoa?.length > 0) {
        resolvePromises2.push(
          supabase.from('dim_pessoas')
            .select('id, nome_completo, cargo_atual, empresa_atual')
            .in('id', resolveByType2.pessoa)
            .then(({ data }) => {
              for (const p of (data || [])) {
                const node = resultMap.get(`pessoa:${p.id}`);
                if (node) {
                  node.label = p.nome_completo || node.label;
                  node.subtitle = [p.cargo_atual, p.empresa_atual].filter(Boolean).join(' @ ');
                }
              }
            })
        );
      }

      if (resolveByType2.politico?.length > 0) {
        resolvePromises2.push(
          supabase.from('dim_politicos')
            .select('id, nome_completo, partido_sigla, cargo_atual')
            .in('id', resolveByType2.politico)
            .then(({ data }) => {
              for (const p of (data || [])) {
                const node = resultMap.get(`politico:${p.id}`);
                if (node) {
                  node.label = p.nome_completo || node.label;
                  node.subtitle = [p.partido_sigla, p.cargo_atual].filter(Boolean).join(' - ');
                }
              }
            })
        );
      }

      if (resolveByType2.noticia?.length > 0) {
        resolvePromises2.push(
          supabase.from('dim_noticias')
            .select('id, titulo, fonte_nome')
            .in('id', resolveByType2.noticia)
            .then(({ data }) => {
              for (const n of (data || [])) {
                const node = resultMap.get(`noticia:${n.id}`);
                if (node) {
                  node.label = (n.titulo || '').substring(0, 80) || node.label;
                  node.subtitle = n.fonte_nome || '';
                }
              }
            })
        );
      }

      await Promise.allSettled(resolvePromises2);
      logger.info('deep_search_missing_endpoints_resolved', { count: missingLinkEndpoints.size });
    }

    // Cross-reference: find text-based connections between results
    const allResults = [...resultMap.entries()];
    const qLower = q.toLowerCase();

    for (let i = 0; i < allResults.length; i++) {
      for (let j = i + 1; j < allResults.length; j++) {
        const [keyA, nodeA] = allResults[i];
        const [keyB, nodeB] = allResults[j];
        if (linkMap.has(`${keyA}::${keyB}`) || linkMap.has(`${keyB}::${keyA}`)) continue;

        const labelA = (nodeA.label || '').toLowerCase();
        const labelB = (nodeB.label || '').toLowerCase();
        const dataStrA = JSON.stringify(nodeA.data || {}).toLowerCase();
        const dataStrB = JSON.stringify(nodeB.data || {}).toLowerCase();

        let connected = false;
        let relType = 'mencionado_em';

        if (labelA.length >= 4 && dataStrB.includes(labelA)) connected = true;
        if (labelB.length >= 4 && dataStrA.includes(labelB)) connected = true;

        if (connected) addLink(keyA, keyB, relType, 'cross_reference');
      }
    }

    // Build graph output
    const nodes = [];
    const edgesOut = [];
    let edgeId = 0;

    for (const [key, node] of resultMap) {
      const sourceWeights = node.sources.map(s => s.weight);
      const confidence = bayesianConfidence(sourceWeights);
      nodes.push({
        id: key, type: node.type, label: node.label, hop: 1,
        data: {
          ...node.data,
          hop: 1,
          subtitle: node.subtitle,
          sources: node.sources.map(s => s.table),
          sourceCount: node.sources.length,
          confidence,
          evidenceScore: Math.round(sourceWeights.reduce((a, b) => a + b, 0) * 100) / 100,
          relevance: Math.round(confidence * 100),
          entityId: String(node.id),
        },
      });
    }

    for (const [, link] of linkMap) {
      const srcNode = resultMap.get(link.source);
      const tgtNode = resultMap.get(link.target);
      if (!srcNode || !tgtNode) continue;
      const relationConfidence = bayesianConfidence(link.evidences.map(item => item.weight));
      edgesOut.push({
        id: `de${++edgeId}`,
        source: link.source, target: link.target,
        tipo_relacao: link.tipo_relacao,
        strength: Math.round(relationConfidence * 100) / 100,
        label: link.evidences.map(item => item.label).join(', '),
      });
    }

    nodes.sort((a, b) => (b.data.confidence || 0) - (a.data.confidence || 0));

    const statsMap = {};
    for (const n of nodes) statsMap[n.type] = (statsMap[n.type] || 0) + 1;

    logger.info('deep_search', { query: q, nodes: nodes.length, edges: edgesOut.length });

    return res.json({
      success: true, query: q, nodes, edges: edgesOut, center: null,
      stats: {
        total_nodes: nodes.length, total_edges: edgesOut.length,
        empresas: statsMap['empresa'] || 0, socios: statsMap['pessoa'] || 0,
        noticias: statsMap['noticia'] || 0, politicos: statsMap['politico'] || 0,
        emendas: statsMap['emenda'] || 0, mandatos: statsMap['mandato'] || 0,
      },
    });
  } catch (err) {
    logger.error('deep_search_error', { query: req.query.q, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Deep search failed' });
  }
});

export default router;
