import { Router } from 'express';
import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { transformToSearchPrompt } from '../services/anthropic.js';
import { searchNews as perplexitySearchNews, getTrustedSources } from '../services/perplexity.js';
import { validateQuery } from '../validation/schemas.js';
import { newsSearchSchema, newsListSchema } from '../validation/schemas.js';
import { escapeLike } from '../utils/sanitize.js';

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
      .select('id, titulo, resumo, fonte_nome, url, segmento, data_publicacao, relevancia_geral', { count: 'exact' })
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

    // Search in title and resumo using ilike
    const escaped = escapeLike(q);
    const { data, error, count } = await supabase
      .from('dim_noticias')
      .select('id, titulo, resumo, fonte_nome, url, segmento, data_publicacao, relevancia_geral', { count: 'exact' })
      .or(`titulo.ilike.%${escaped}%,resumo.ilike.%${escaped}%`)
      .order('data_publicacao', { ascending: false })
      .limit(limit);

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
router.get('/search-ai', async (req, res) => {
  try {
    const q = req.query.q?.trim();
    const fonte = req.query.fonte?.trim() || null;
    const idioma = req.query.idioma || 'pt';
    const pais = req.query.pais || 'BR';
    const dataInicio = req.query.data_inicio || null;
    const dataFim = req.query.data_fim || null;
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);

    if (!q) {
      return res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
    }

    logger.info('[NEWS-AI] Starting search', { q, fonte, idioma, pais });

    // Step 1: Transform keywords using Claude
    const transformResult = await transformToSearchPrompt(q, fonte, idioma, pais);

    logger.info('[NEWS-AI] Keywords transformed', {
      original: q,
      transformed: transformResult.searchQuery,
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
