import { Router } from 'express';
import { getNetworkGraph, getNetworkStats } from '../services/graph-queries.js';
import { supabase } from '../database/supabase.js';
import { getCompanyFull } from '../services/cnpja.js';
import {
  getEstimatedCompanyCount,
  listCompanyNodes,
  searchCompaniesByName,
} from '../services/company-search.js';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';

const router = Router();

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
            data: { cnpj: d.cnpj, cidade: d.cidade, estado: d.estado }
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
            data: { cargo: d.cargo_atual, empresa: d.empresa_atual }
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
            data: { partido: d.partido_sigla, cargo: d.cargo_atual }
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

    const nodes = nodeArrays.flat();

    if (edgesError) {
      logger.error('graph_data_edges_error', { error: edgesError.message, code: edgesError.code });
    }

    const edges = (edgesRaw || []).map(e => ({
      id: String(e.id),
      source: String(e.source_id),
      target: String(e.target_id),
      tipo_relacao: e.tipo_relacao,
      strength: e.strength
    }));

    logger.info('graph_data_loaded', { total_nodes: nodes.length, total_edges: edges.length, entity_type: entityType });

    return res.json({
      success: true,
      nodes,
      edges,
      next_cursor_id: entityType === 'empresa' || !entityType
        ? (nodes.filter(n => n.type === 'empresa').at(-1)?.id || null)
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

    const validTypes = ['empresa', 'pessoa', 'politico', 'emenda', 'noticia'];
    if (!validTypes.includes(entityType)) {
      return res.status(400).json({ success: false, error: `Invalid entity type. Must be one of: ${validTypes.join(', ')}` });
    }

    if (!entityId) {
      return res.status(400).json({ success: false, error: 'Entity ID is required' });
    }

    const result = await getNetworkGraph(entityType, entityId, 1, 50);

    // The center node is the one with hop === 0
    const centerNode = result.nodes.find(n => n.hop === 0) || { id: entityId, type: entityType, label: `${entityType} #${entityId}` };

    const nodes = result.nodes.map(n => ({
      id: String(n.id),
      type: n.type,
      label: n.label,
      data: { hop: n.hop, cnpj: n.cnpj, cargo: n.cargo, partido: n.partido }
    }));

    const edges = result.edges.map(e => ({
      id: String(e.id),
      source: String(e.source_id),
      target: String(e.target_id),
      tipo_relacao: e.tipo_relacao,
      strength: e.strength
    }));

    logger.info('graph_expand', { entityType, entityId, nodes: nodes.length, edges: edges.length });

    return res.json({
      success: true,
      nodes,
      edges,
      center: { id: String(centerNode.id), type: centerNode.type, label: centerNode.label }
    });
  } catch (err) {
    logger.error('graph_expand_error', { entityType: req.params.entityType, entityId: req.params.entityId, error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to expand node' });
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
    const pattern = `%${escapeLike(q)}%`;

    const [empresasRes, pessoasRes] = await Promise.all([
      searchCompaniesByName({ query: q, limit }),
      supabase
        .from('dim_pessoas')
        .select('id, nome_completo, cargo_atual, empresa_atual')
        .ilike('nome_completo', pattern)
        .limit(limit)
    ]);

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

    logger.info('graph_search', { query: q, results: results.length });

    return res.json({ success: true, results: results.slice(0, limit) });
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

    const validTypes = ['empresa', 'pessoa', 'politico', 'emenda', 'noticia'];
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
// GET /explore?q=cesla  - Real-time graph exploration by company name or CNPJ
// Uses CNPJá API as primary data source for company + QSA (sócios).
// Falls back to local DB if CNPJá is unavailable.
// News are always searched locally via name correlation.
// ---------------------------------------------------------------------------
router.get('/explore', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ success: false, error: 'Query "q" must be at least 2 characters' });
    }

    // Detect if query is a CNPJ (digits only, 11-14 chars)
    const cleanDigits = q.replace(/[^\d]/g, '');
    const isCnpjQuery = cleanDigits.length >= 11 && cleanDigits.length <= 14 && /^\d+$/.test(cleanDigits);

    let cnpjToLookup = null;
    let localEmpresa = null;

    if (isCnpjQuery) {
      // Query is a CNPJ - pad to 14 digits and use directly
      cnpjToLookup = cleanDigits.padStart(14, '0');
    } else {
      // Query is a company name - search local DB to find CNPJ
      const candidates = await searchCompaniesByName({ query: q, limit: 20 });
      if (candidates && candidates.length > 0) {
        localEmpresa = candidates[0];
        if (localEmpresa.cnpj) {
          cnpjToLookup = localEmpresa.cnpj.replace(/[^\d]/g, '');
        }
      }
    }

    // No CNPJ found at all
    if (!cnpjToLookup && !localEmpresa) {
      return res.json({ success: true, nodes: [], edges: [], center: null, stats: { total_nodes: 0, total_edges: 0, empresas: 0, socios: 0, noticias: 0 }, message: 'Nenhuma empresa encontrada' });
    }

    // Step 1: Fetch company + QSA from CNPJá
    let cnpjaData = null;
    if (cnpjToLookup) {
      cnpjaData = await getCompanyFull(cnpjToLookup);
      if (cnpjaData) {
        logger.info('explore_cnpja_ok', { cnpj: cnpjToLookup, socios: cnpjaData.socios.length });
      } else {
        logger.warn('explore_cnpja_fail', { cnpj: cnpjToLookup });
      }
    }

    // Build empresa node - prefer CNPJá data, fallback to local
    const empresaId = localEmpresa ? String(localEmpresa.id) : `cnpja-${cnpjToLookup}`;
    const empresaLabel = cnpjaData
      ? (cnpjaData.nome_fantasia || cnpjaData.razao_social)
      : (localEmpresa?.nome_fantasia || localEmpresa?.razao_social || `CNPJ ${cnpjToLookup}`);
    const empresaCidade = cnpjaData?.cidade || localEmpresa?.cidade || null;
    const empresaEstado = cnpjaData?.estado || localEmpresa?.estado || null;
    const empresaCnpj = cnpjaData?.cnpj || localEmpresa?.cnpj || cnpjToLookup;

    const nodes = [];
    const edges = [];
    let edgeId = 0;

    // Add empresa as center node
    nodes.push({
      id: empresaId,
      type: 'empresa',
      label: empresaLabel,
      hop: 0,
      data: {
        cnpj: empresaCnpj,
        cidade: empresaCidade,
        estado: empresaEstado,
        cnae: cnpjaData?.cnae_descricao || null,
        porte: cnpjaData?.porte || null,
        capital_social: cnpjaData?.capital_social || null,
        situacao: cnpjaData?.situacao_cadastral || null,
        fonte: cnpjaData ? 'CNPJá' : 'Local DB'
      }
    });

    // Step 2: Add sócios from CNPJá QSA
    const sociosMap = new Map();

    if (cnpjaData && cnpjaData.socios.length > 0) {
      for (const socio of cnpjaData.socios) {
        const socioId = `socio-${socio.cpf_cnpj || socio.nome.replace(/\s/g, '-').toLowerCase()}`;
        if (sociosMap.has(socioId)) continue;

        sociosMap.set(socioId, {
          id: socioId,
          nome: socio.nome,
          cargo: socio.cargo
        });

        nodes.push({
          id: socioId,
          type: 'pessoa',
          label: socio.nome,
          hop: 1,
          data: {
            cargo: socio.cargo,
            desde: socio.desde,
            tipo: socio.tipo,
            fonte: 'CNPJá'
          }
        });

        edges.push({
          id: `e${++edgeId}`,
          source: socioId,
          target: empresaId,
          tipo_relacao: 'societaria',
          strength: 0.9,
          label: socio.cargo || 'Sócio'
        });
      }
    }

    // Fallback: if CNPJá didn't return sócios, try local fato_transacao_empresas
    if (sociosMap.size === 0 && localEmpresa) {
      const { data: transacoes, error: txError } = await supabase
        .from('fato_transacao_empresas')
        .select(`
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
        logger.warn('explore_socios_fallback_error', { error: txError.message });
      }

      for (const tx of (transacoes || [])) {
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
          data: { cargo: tx.cargo || tx.qualificacao || pessoa.cargo_atual, empresa: pessoa.empresa_atual, fonte: 'Local DB' }
        });

        edges.push({
          id: `e${++edgeId}`,
          source: pessoaId,
          target: empresaId,
          tipo_relacao: 'societaria',
          strength: 0.9,
          label: tx.cargo || tx.qualificacao || 'Sócio'
        });
      }
    }

    // Step 3: Search news mentioning empresa name OR sócios names
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

    // Step 4: Create news nodes and edges based on name matching
    const noticiasAdded = new Set();

    for (const noticia of (noticias || [])) {
      const noticiaId = String(noticia.id);
      const textToSearch = `${noticia.titulo || ''} ${noticia.conteudo || ''}`.toLowerCase();

      const mentionsEmpresa = textToSearch.includes(empresaLabel.toLowerCase());
      const mentionedSocios = [];

      for (const [socioId, socio] of sociosMap) {
        if (socio.nome && textToSearch.includes(socio.nome.toLowerCase())) {
          mentionedSocios.push(socioId);
        }
      }

      if (!mentionsEmpresa && mentionedSocios.length === 0) continue;

      if (!noticiasAdded.has(noticiaId)) {
        noticiasAdded.add(noticiaId);
        nodes.push({
          id: noticiaId,
          type: 'noticia',
          label: (noticia.titulo || '').substring(0, 80),
          hop: 2,
          data: { fonte: noticia.fonte_nome, data_publicacao: noticia.data_publicacao }
        });
      }

      if (mentionsEmpresa) {
        edges.push({
          id: `e${++edgeId}`,
          source: empresaId,
          target: noticiaId,
          tipo_relacao: 'mencionado_em',
          strength: 0.7,
          label: 'Mencionado'
        });
      }

      for (const socioId of mentionedSocios) {
        edges.push({
          id: `e${++edgeId}`,
          source: socioId,
          target: noticiaId,
          tipo_relacao: 'mencionado_em',
          strength: 0.6,
          label: 'Mencionado'
        });
      }
    }

    const stats = {
      total_nodes: nodes.length,
      total_edges: edges.length,
      empresas: 1,
      socios: sociosMap.size,
      noticias: noticiasAdded.size
    };

    logger.info('graph_explore', { query: q, source: cnpjaData ? 'cnpja' : 'local', ...stats });

    return res.json({
      success: true,
      nodes,
      edges,
      center: { id: empresaId, type: 'empresa', label: empresaLabel },
      stats
    });
  } catch (err) {
    logger.error('graph_explore_error', { query: req.query.q, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Explore failed' });
  }
});

export default router;
