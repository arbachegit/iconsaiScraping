import { Router } from 'express';
import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { transformToSearchPrompt } from '../services/anthropic.js';
import { searchNews as perplexitySearchNews, getTrustedSources } from '../services/perplexity.js';
import { validateQuery, validateBody } from '../validation/schemas.js';
import { newsSearchSchema, newsListSchema, newsClassifyBatchSchema, newsEnrichBatchSchema, newsSearchAiSchema } from '../validation/schemas.js';
import { escapeLike, sanitizeForLog } from '../utils/sanitize.js';
import { runClassificationPipeline, countUnclassified } from '../services/news-classifier.js';
import { runEnrichmentPipeline, countUnenriched } from '../services/news-enricher.js';

const router = Router();

/**
 * GET /api/news/list
 * List recent news
 */
router.get('/list', validateQuery(newsListSchema), async (req, res) => {
  try {
    const { limit, offset, segmento } = req.query;

    let query = supabase
      .from('dim_noticias')
      .select('id, titulo, resumo, fonte_nome, url, segmento, data_publicacao, relevancia_geral, tipo_classificacao, credibilidade_score, tema_principal', { count: 'exact' })
      .order('data_publicacao', { ascending: false })
      .range(offset, offset + limit - 1);

    if (segmento && segmento !== 'todos') {
      query = query.eq('segmento', segmento);
    }

    const { data, error, count } = await query;

    if (error) {
      logger.error('Error listing news', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: count,
      news: data
    });

  } catch (error) {
    logger.error('Error listing news', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/search
 * Search news by query text
 */
router.get('/search', validateQuery(newsSearchSchema), async (req, res) => {
  try {
    const { q, limit } = req.query;

    // Search using RPC with FTS (tsvector) → ilike fallback
    const { data: rpcData, error: rpcError } = await supabase.rpc('search_noticias_ranked_v1', {
      p_query: q,
      p_limit: limit,
    });

    let data = rpcData;
    let error = rpcError;
    let count = rpcData?.length || 0;

    // Fallback to ilike if RPC fails
    if (rpcError) {
      logger.warn('RPC search_noticias_ranked_v1 failed, falling back to ilike', { error: rpcError.message });
      const escaped = escapeLike(q);
      const result = await supabase
        .from('dim_noticias')
        .select('id, titulo, resumo, fonte_nome, url, segmento, data_publicacao, relevancia_geral', { count: 'exact' })
        .or(`titulo.ilike.%${escaped}%,resumo.ilike.%${escaped}%`)
        .order('data_publicacao', { ascending: false })
        .limit(limit);
      data = result.data;
      error = result.error;
      count = result.data?.length || 0;
    }

    if (error) {
      logger.error('Error searching news', { error: error.message, query: q });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: data?.length || 0,
      query: q,
      news: data || []
    });

  } catch (error) {
    logger.error('Error searching news', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/search-ai
 * AI-powered news search using Claude + Perplexity
 * Transforms keywords into optimized query and searches in real-time
 */
router.get('/search-ai', validateQuery(newsSearchAiSchema), async (req, res) => {
  try {
    const { q, fonte, idioma, pais, data_inicio: dataInicio, data_fim: dataFim, limit } = req.query;

    logger.info('news_ai_search', { q: sanitizeForLog(q), fonte: fonte ? sanitizeForLog(fonte) : null, idioma, pais });

    // Step 1: Transform keywords using Claude
    const transformResult = await transformToSearchPrompt(q, fonte, idioma, pais);

    logger.info('news_ai_transformed', {
      original: sanitizeForLog(q),
      transformed: sanitizeForLog(transformResult.searchQuery),
      expanded: transformResult.expanded
    });

    // Step 2: Search news using Perplexity
    const searchResult = await perplexitySearchNews(transformResult.searchQuery, {
      fonte,
      idioma,
      dataInicio,
      dataFim,
      limit
    });

    if (!searchResult.success) {
      return res.status(500).json({
        success: false,
        error: searchResult.error,
        original_query: q,
        transformed_query: transformResult.searchQuery
      });
    }

    res.json({
      success: true,
      count: searchResult.total || searchResult.news?.length || 0,
      original_query: q,
      transformed_query: transformResult.searchQuery,
      query_context: transformResult.context,
      expanded_keywords: transformResult.keywords,
      fonte_filter: fonte,
      news: searchResult.news || [],
      citations: searchResult.citations || [],
      search_metadata: {
        idioma,
        pais,
        data_inicio: dataInicio,
        data_fim: dataFim,
        ai_expanded: transformResult.expanded
      }
    });

  } catch (error) {
    logger.error('[NEWS-AI] Error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/sources/trusted
 * List available trusted sources for filtering
 */
router.get('/sources/trusted', (req, res) => {
  const sources = getTrustedSources();
  res.json({
    success: true,
    count: sources.length,
    sources: sources.map(name => ({ nome: name, ativo: true }))
  });
});

/**
 * GET /api/news/aggregation
 * Aggregated stats for news dashboard
 */
router.get('/aggregation', async (req, res) => {
  try {
    // Run queries in parallel
    const [bySegmento, byFonte, recentCount, totalResult, byClassificacao, byTema, byCredibilidade] = await Promise.all([
      // By segmento
      supabase.from('dim_noticias').select('segmento').not('segmento', 'is', null),
      // By fonte
      supabase.from('dim_noticias').select('fonte_nome').not('fonte_nome', 'is', null),
      // Recent 7 days count
      supabase.from('dim_noticias').select('data_publicacao').gte('data_publicacao', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      // Total count
      supabase.from('dim_noticias').select('*', { count: 'exact', head: true }),
      // By tipo_classificacao
      supabase.from('dim_noticias').select('tipo_classificacao').not('tipo_classificacao', 'is', null),
      // By tema_principal
      supabase.from('dim_noticias').select('tema_principal').not('tema_principal', 'is', null),
      // By credibilidade_score
      supabase.from('dim_noticias').select('credibilidade_score').not('credibilidade_score', 'is', null),
    ]);

    // Aggregate segmento
    const segmentoGrouped = {};
    for (const r of (bySegmento.data || [])) {
      segmentoGrouped[r.segmento] = (segmentoGrouped[r.segmento] || 0) + 1;
    }
    const by_segmento = Object.entries(segmentoGrouped)
      .map(([segmento, count]) => ({ segmento, count }))
      .sort((a, b) => b.count - a.count);

    // Aggregate fonte
    const fonteGrouped = {};
    for (const r of (byFonte.data || [])) {
      fonteGrouped[r.fonte_nome] = (fonteGrouped[r.fonte_nome] || 0) + 1;
    }
    const by_fonte = Object.entries(fonteGrouped)
      .map(([fonte, count]) => ({ fonte, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Aggregate tipo_classificacao
    const classificacaoGrouped = {};
    for (const r of (byClassificacao.data || [])) {
      classificacaoGrouped[r.tipo_classificacao] = (classificacaoGrouped[r.tipo_classificacao] || 0) + 1;
    }
    const by_classificacao = Object.entries(classificacaoGrouped)
      .map(([tipo, count]) => ({ tipo, count }))
      .sort((a, b) => b.count - a.count);

    // Aggregate tema_principal
    const temaGrouped = {};
    for (const r of (byTema.data || [])) {
      temaGrouped[r.tema_principal] = (temaGrouped[r.tema_principal] || 0) + 1;
    }
    const by_tema = Object.entries(temaGrouped)
      .map(([tema, count]) => ({ tema, count }))
      .sort((a, b) => b.count - a.count);

    // Aggregate credibilidade into layers
    const credLayers = { alta: 0, media: 0, baixa: 0 };
    for (const r of (byCredibilidade.data || [])) {
      const s = parseFloat(r.credibilidade_score);
      if (s >= 0.8) credLayers.alta++;
      else if (s >= 0.5) credLayers.media++;
      else credLayers.baixa++;
    }

    res.json({
      success: true,
      totals: {
        total_noticias: totalResult.count || 0,
        ultimos_7_dias: recentCount.data?.length || 0,
      },
      by_segmento,
      by_fonte,
      by_classificacao,
      by_tema,
      credibilidade: credLayers,
    });
  } catch (error) {
    logger.error('Error getting news aggregation', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/classify-status
 * Check how many news articles still need classification
 */
router.get('/classify-status', async (req, res) => {
  try {
    const unclassified = await countUnclassified();

    const { count: total } = await supabase
      .from('dim_noticias')
      .select('id', { count: 'exact', head: true });

    res.json({
      success: true,
      total: total || 0,
      unclassified,
      classified: (total || 0) - unclassified,
      coverage: total ? (((total - unclassified) / total) * 100).toFixed(1) + '%' : '0%',
    });
  } catch (error) {
    logger.error('Error getting classify status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/news/classify-batch
 * Run the AI classification pipeline on unclassified news
 * Body: { maxBatches?: number (1-100, default 10), batchSize?: number (5-50, default 25) }
 */
router.post('/classify-batch', validateBody(newsClassifyBatchSchema), async (req, res) => {
  try {
    const { maxBatches, batchSize } = req.body;

    logger.info('Classification batch triggered', { maxBatches, batchSize });

    const stats = await runClassificationPipeline({ maxBatches, batchSize });

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error('Classification batch error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/enrich-status
 * Check how many classified news still need enrichment (signals + entities + relevance)
 */
router.get('/enrich-status', async (req, res) => {
  try {
    const unenriched = await countUnenriched();

    const { count: classified } = await supabase
      .from('dim_noticias')
      .select('id', { count: 'exact', head: true })
      .not('tipo_classificacao', 'is', null);

    const enriched = (classified || 0) - unenriched;

    res.json({
      success: true,
      classified: classified || 0,
      unenriched,
      enriched,
      coverage: classified ? ((enriched / classified) * 100).toFixed(1) + '%' : '0%',
    });
  } catch (error) {
    logger.error('Error getting enrich status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/news/enrich-batch
 * Run the AI enrichment pipeline (signals + entities + relevance)
 * Body: { maxBatches?: number (1-100, default 10), batchSize?: number (5-30, default 15) }
 */
router.post('/enrich-batch', validateBody(newsEnrichBatchSchema), async (req, res) => {
  try {
    const { maxBatches, batchSize } = req.body;

    logger.info('Enrichment batch triggered', { maxBatches, batchSize });

    const stats = await runEnrichmentPipeline({ maxBatches, batchSize });

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error('Enrichment batch error', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/:id
 * Get news details with topics
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get news data
    const { data: noticia, error: noticiaError } = await supabase
      .from('dim_noticias')
      .select('*')
      .eq('id', id)
      .single();

    if (noticiaError || !noticia) {
      return res.status(404).json({ success: false, error: 'Notícia não encontrada' });
    }

    // Get topics
    const { data: topicos } = await supabase
      .from('fato_noticias_topicos')
      .select('*')
      .eq('noticia_id', id)
      .order('relevancia', { ascending: false });

    // Get related companies
    const { data: empresas } = await supabase
      .from('fato_noticias_empresas')
      .select(`
        tipo_relacao,
        relevancia,
        sentimento_empresa,
        dim_empresas (
          id,
          cnpj,
          razao_social,
          nome_fantasia
        )
      `)
      .eq('noticia_id', id);

    // Get related people
    const { data: pessoas } = await supabase
      .from('fato_noticias_pessoas')
      .select(`
        tipo_relacao,
        dim_pessoas (
          id,
          nome_completo,
          cargo_atual
        )
      `)
      .eq('noticia_id', id);

    res.json({
      success: true,
      noticia,
      topicos: topicos || [],
      empresas: empresas?.map(e => ({
        ...e.dim_empresas,
        tipo_relacao: e.tipo_relacao,
        relevancia: e.relevancia,
        sentimento: e.sentimento_empresa
      })) || [],
      pessoas: pessoas?.map(p => ({
        ...p.dim_pessoas,
        tipo_relacao: p.tipo_relacao
      })) || []
    });

  } catch (error) {
    logger.error('Error getting news', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/by-company/:empresaId
 * Get news related to a company
 */
router.get('/by-company/:empresaId', async (req, res) => {
  try {
    const { empresaId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const { data, error } = await supabase
      .from('fato_noticias_empresas')
      .select(`
        tipo_relacao,
        relevancia,
        sentimento_empresa,
        contexto,
        dim_noticias (
          id,
          titulo,
          resumo,
          fonte_nome,
          url,
          segmento,
          data_publicacao,
          relevancia_geral
        )
      `)
      .eq('empresa_id', empresaId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('Error fetching company news', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: data.length,
      news: data.map(item => ({
        ...item.dim_noticias,
        tipo_relacao: item.tipo_relacao,
        relevancia_empresa: item.relevancia,
        sentimento: item.sentimento_empresa,
        contexto: item.contexto
      }))
    });

  } catch (error) {
    logger.error('Error fetching company news', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/by-topic/:topico
 * Get news by topic
 */
router.get('/by-topic/:topico', async (req, res) => {
  try {
    const { topico } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    // Slugify topic for search
    const topicoSlug = topico
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-');

    const { data, error } = await supabase
      .from('fato_noticias_topicos')
      .select(`
        topico,
        relevancia,
        sentimento,
        impacto_mercado,
        dim_noticias (
          id,
          titulo,
          resumo,
          fonte_nome,
          url,
          segmento,
          data_publicacao,
          relevancia_geral
        )
      `)
      .ilike('topico_slug', `%${escapeLike(topicoSlug)}%`)
      .order('relevancia', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('Error fetching news by topic', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: data.length,
      topico: topico,
      news: data.map(item => ({
        ...item.dim_noticias,
        topico: item.topico,
        relevancia_topico: item.relevancia,
        sentimento: item.sentimento,
        impacto: item.impacto_mercado
      }))
    });

  } catch (error) {
    logger.error('Error fetching news by topic', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/topics/list
 * List all topics with counts
 */
router.get('/topics/list', async (req, res) => {
  try {
    const { data, error } = await supabase
      .rpc('get_news_topics_summary');

    // Fallback if RPC doesn't exist
    if (error) {
      const { data: topicsData, error: topicsError } = await supabase
        .from('fato_noticias_topicos')
        .select('topico, topico_slug')
        .limit(100);

      if (topicsError) {
        return res.status(500).json({ success: false, error: topicsError.message });
      }

      // Group by topic
      const grouped = {};
      for (const t of topicsData) {
        const key = t.topico_slug || t.topico;
        if (!grouped[key]) {
          grouped[key] = { topico: t.topico, count: 0 };
        }
        grouped[key].count++;
      }

      return res.json({
        success: true,
        topics: Object.values(grouped).sort((a, b) => b.count - a.count)
      });
    }

    res.json({
      success: true,
      topics: data
    });

  } catch (error) {
    logger.error('Error listing topics', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/news/sources/list
 * List trusted news sources
 */
router.get('/sources/list', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('dim_fontes_noticias')
      .select('*')
      .eq('ativo', true)
      .order('tipo', { ascending: true });

    if (error) {
      logger.error('Error listing sources', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: data.length,
      sources: data
    });

  } catch (error) {
    logger.error('Error listing sources', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
