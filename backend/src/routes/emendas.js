import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';
import {
  validateQuery,
  validateParams,
  listEmendasSchema,
  searchEmendasSchema,
  timeSeriesEmendasSchema,
  listEmendasSubnacionaisSchema,
  integerIdParamSchema
} from '../validation/schemas.js';

const router = Router();

// Cliente Supabase para brasil-data-hub (fato_emendas_parlamentares)
const brasilDataHub = process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
  ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
  : null;

// Cliente Supabase para iconsai-scraping (noticias, taxonomia, associações)
const scrapingDb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

/**
 * GET /api/emendas/list
 * List emendas with pagination and optional filters
 */
router.get('/list', validateQuery(listEmendasSchema), async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({
        success: false,
        error: 'Brasil Data Hub not configured. Set BRASIL_DATA_HUB_URL and BRASIL_DATA_HUB_KEY.'
      });
    }

    // Query params already validated and transformed by Zod
    const { limit, offset, autor, uf, ano, tipo } = req.query;

    let query = brasilDataHub
      .from('fato_emendas_parlamentares')
      .select('*', { count: 'exact' })
      .order('ano', { ascending: false })
      .range(offset, offset + limit - 1);

    // All query params already validated and sanitized by Zod
    if (autor) {
      query = query.ilike('autor', `%${escapeLike(autor)}%`);
    }
    if (uf) {
      query = query.eq('uf', uf);
    }
    if (ano) {
      query = query.eq('ano', ano);
    }
    if (tipo) {
      query = query.ilike('tipo', `%${escapeLike(tipo)}%`);
    }

    const { data, error, count } = await query;

    if (error) {
      logger.error('Error listing emendas', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: count,
      emendas: data || []
    });

  } catch (error) {
    logger.error('Error listing emendas', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/emendas/search
 * Search emendas by text (autor, descricao, localidade, etc.)
 */
router.get('/search', validateQuery(searchEmendasSchema), async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({
        success: false,
        error: 'Brasil Data Hub not configured. Set BRASIL_DATA_HUB_URL and BRASIL_DATA_HUB_KEY.'
      });
    }

    // Query params already validated by Zod (q >= 2 chars, sanitized)
    const { q, limit } = req.query;

    // Hybrid search: buscar_emendas (v2) → search_emendas_ranked_v1 (v1) → ilike fallback
    let data, error, count;

    const { data: rpcData, error: rpcError } = await brasilDataHub.rpc('buscar_emendas', {
      p_query: q,
      p_limit: limit,
    });

    if (!rpcError && rpcData) {
      data = rpcData;
      count = rpcData.length;
      error = null;
    } else if (rpcError && (rpcError.code === '42883' || rpcError.code === 'PGRST202')) {
      // buscar_emendas not yet deployed — try v1 fallback
      logger.warn('buscar_emendas not found, falling back to v1', { code: rpcError.code });
      const { data: v1Data, error: v1Error } = await brasilDataHub.rpc('search_emendas_ranked_v1', {
        p_query: q,
        p_limit: limit,
      });
      if (!v1Error && v1Data) {
        data = v1Data;
        count = v1Data.length;
        error = null;
      } else {
        // Final fallback: ilike
        const escaped = escapeLike(q);
        const result = await brasilDataHub
          .from('fato_emendas_parlamentares')
          .select('*', { count: 'exact' })
          .or(`autor.ilike.%${escaped}%,descricao.ilike.%${escaped}%,localidade.ilike.%${escaped}%`)
          .order('ano', { ascending: false })
          .limit(limit);
        data = result.data;
        error = result.error;
        count = result.data?.length || 0;
      }
    } else {
      if (rpcError) {
        logger.warn('buscar_emendas failed, falling back to ilike', { error: rpcError.message });
      }
      const escaped = escapeLike(q);
      const result = await brasilDataHub
        .from('fato_emendas_parlamentares')
        .select('*', { count: 'exact' })
        .or(`autor.ilike.%${escaped}%,descricao.ilike.%${escaped}%,localidade.ilike.%${escaped}%`)
        .order('ano', { ascending: false })
        .limit(limit);
      data = result.data;
      error = result.error;
      count = result.data?.length || 0;
    }

    if (error) {
      logger.error('Error searching emendas', { error: error.message, query: q.replace(/[\r\n]/g, ' ') });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: data?.length || 0,
      query: q,
      emendas: data || []
    });

  } catch (error) {
    logger.error('Error searching emendas', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/emendas/aggregation
 * Context Intelligence: aggregated stats across all 4 emendas tables.
 *
 * RPCs answer contextual questions:
 *  - get_emendas_context_totals → "Qual é o panorama?"
 *  - get_emendas_beneficiary_focus → "Pra quem vai o dinheiro?"
 *  - get_emendas_top_funcoes → "Onde mais se investe?"
 *  - get_emendas_context_top_autores → "Quem mais direciona?"
 *  - get_emendas_top_destinos → "Pra onde vai?"
 *  - get_emendas_by_tipo_emenda → "Qual o perfil?"
 *  - get_emendas_mecanismos → "Como o dinheiro flui?"
 */
router.get('/aggregation', async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({ success: false, error: 'Brasil Data Hub not configured.' });
    }

    // All 7 context RPCs in parallel
    const [totals, beneficiaries, funcoes, autores, destinos, tipos, mecanismos] = await Promise.all([
      brasilDataHub.rpc('get_emendas_context_totals'),
      brasilDataHub.rpc('get_emendas_beneficiary_focus'),
      brasilDataHub.rpc('get_emendas_top_funcoes', { p_limit: 10 }),
      brasilDataHub.rpc('get_emendas_context_top_autores', { p_limit: 10 }),
      brasilDataHub.rpc('get_emendas_top_destinos', { p_limit: 10 }),
      brasilDataHub.rpc('get_emendas_by_tipo_emenda'),
      brasilDataHub.rpc('get_emendas_mecanismos'),
    ]);

    // Check for RPC errors
    const rpcErrors = [totals, beneficiaries, funcoes, autores, destinos, tipos, mecanismos]
      .filter(r => r.error);

    if (rpcErrors.length > 0) {
      const firstError = rpcErrors[0].error;
      logger.warn('Emendas context RPCs failed', {
        failed: rpcErrors.length,
        code: firstError.code,
        message: firstError.message,
      });

      // If RPCs don't exist yet, return minimal fallback
      if (firstError.code === '42883' || firstError.code === 'PGRST202') {
        const { count } = await brasilDataHub
          .from('fato_emendas_parlamentares')
          .select('*', { count: 'exact', head: true });

        return res.json({
          success: true,
          rpc_available: false,
          totals: { total_emendas: count || 0 },
          beneficiaries: [],
          top_funcoes: [],
          top_autores: [],
          top_destinos: [],
          by_tipo: [],
          mecanismos: null,
        });
      }
    }

    res.json({
      success: true,
      rpc_available: true,
      totals: totals.data || {},
      beneficiaries: beneficiaries.data || [],
      top_funcoes: funcoes.data || [],
      top_autores: autores.data || [],
      top_destinos: destinos.data || [],
      by_tipo: tipos.data || [],
      mecanismos: mecanismos.data || null,
    });
  } catch (error) {
    logger.error('Error getting emendas aggregation', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/emendas/time-series
 * Context Intelligence: temporal evolution of budget execution.
 *
 * Answers: "Como evolui o orçamento ao longo dos anos?"
 * Optional filters: funcao, uf, autor, tipo_emenda
 */
router.get('/time-series', validateQuery(timeSeriesEmendasSchema), async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({ success: false, error: 'Brasil Data Hub not configured.' });
    }

    // Query params already validated and trimmed by Zod
    const { funcao, uf, autor, tipo_emenda } = req.query;

    const [general, byFuncao, concentration] = await Promise.all([
      brasilDataHub.rpc('get_emendas_time_series', {
        p_funcao: funcao || null,
        p_uf: uf || null,
        p_autor: autor || null,
        p_tipo_emenda: tipo_emenda || null,
      }),
      brasilDataHub.rpc('get_emendas_funcao_time_series', { p_limit: 8 }),
      brasilDataHub.rpc('get_emendas_concentration'),
    ]);

    // Check if RPCs exist
    const rpcErrors = [general, byFuncao, concentration].filter(r => r.error);
    if (rpcErrors.length > 0) {
      const firstError = rpcErrors[0].error;
      if (firstError.code === '42883' || firstError.code === 'PGRST202') {
        return res.json({ success: true, rpc_available: false, series: [], by_funcao: [], concentration: null });
      }
    }

    res.json({
      success: true,
      rpc_available: true,
      series: general.data || [],
      by_funcao: byFuncao.data || [],
      concentration: concentration.data || null,
    });
  } catch (error) {
    logger.error('Error getting emendas time series', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/emendas/subnacionais
 * List subnational emendas (estaduais + municipais) with filters
 */
router.get('/subnacionais', validateQuery(listEmendasSubnacionaisSchema), async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({
        success: false,
        error: 'Brasil Data Hub not configured.'
      });
    }

    // All query params (including esfera) validated and trimmed by Zod
    const { limit, offset, autor, uf, ano, tipo, esfera } = req.query;

    let query = brasilDataHub
      .from('fato_emendas_subnacionais')
      .select('*', { count: 'exact' })
      .order('ano', { ascending: false })
      .range(offset, offset + limit - 1);

    if (autor) query = query.ilike('autor', `%${escapeLike(autor)}%`);
    if (uf) query = query.eq('uf', uf);
    if (ano) query = query.eq('ano', ano);
    if (tipo) query = query.ilike('tipo', `%${escapeLike(tipo)}%`);
    if (esfera) query = query.eq('esfera', esfera);

    const { data, error, count } = await query;

    if (error) {
      logger.error('Error listing subnacional emendas', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count,
      emendas: data || []
    });
  } catch (error) {
    logger.error('Error listing subnacional emendas', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/emendas/:id/context
 * Context Intelligence: related news, taxonomy, and associations for an emenda.
 * Connects emenda (Brasil Data Hub) with noticias (scraping DB) via shared taxonomy.
 */
router.get('/:id/context', validateParams(integerIdParamSchema), async (req, res) => {
  try {
    if (!brasilDataHub || !scrapingDb) {
      return res.status(503).json({ success: false, error: 'Database clients not configured.' });
    }

    const { id } = req.params;

    // 1. Get emenda + parallel context queries from Brasil Data Hub
    const { data: emenda, error: emendaErr } = await brasilDataHub
      .from('fato_emendas_parlamentares')
      .select('id, autor, funcao, subfuncao, localidade, tipo_emenda, ano, codigo_emenda, numero_emenda, partido, codigo_ibge, is_emenda_pix, valor_empenhado, valor_liquidado, valor_pago, valor_resto_inscrito, valor_resto_cancelado, valor_resto_pago')
      .eq('id', id)
      .single();

    if (emendaErr || !emenda) {
      return res.status(404).json({ success: false, error: 'Emenda not found' });
    }

    // 2. Parallel: taxonomy + favorecidos + author history + associations
    const [mappingResult, favorecidosResult, autorHistoryResult] = await Promise.all([
      // Taxonomy mapping
      scrapingDb
        .from('map_funcao_taxonomia')
        .select('taxonomia_slug')
        .eq('funcao', emenda.funcao)
        .single(),
      // Top beneficiaries for this emenda's author + funcao combo
      brasilDataHub
        .from('fato_emendas_favorecidos')
        .select('tipo_favorecido, favorecido, uf_favorecido, municipio_favorecido, valor_recebido')
        .eq('codigo_emenda', emenda.codigo_emenda)
        .order('valor_recebido', { ascending: false })
        .limit(10),
      // Author time series (try RPC, ignore error)
      brasilDataHub.rpc('get_emendas_autor_time_series', { p_autor: emenda.autor }),
    ]);

    const taxonomiaSlug = mappingResult.data?.taxonomia_slug || null;

    // 3. Get taxonomy info
    let taxonomia = null;
    if (taxonomiaSlug) {
      const { data } = await scrapingDb
        .from('dim_taxonomia_tematica')
        .select('slug, nome, cor, icone')
        .eq('slug', taxonomiaSlug)
        .single();
      taxonomia = data;
    }

    // 4. Get pre-computed associations for this emenda
    const { data: associations } = await scrapingDb
      .from('fato_associacoes_contextuais')
      .select('origem_id, tipo_associacao, confianca, evidencia')
      .eq('destino_tipo', 'emenda')
      .eq('destino_id', String(id))
      .eq('origem_tipo', 'noticia')
      .order('confianca', { ascending: false })
      .limit(10);

    // 5. Fetch the actual noticias for those associations
    let noticias = [];
    if (associations && associations.length > 0) {
      const noticiaIds = associations.map(a => a.origem_id);
      const { data } = await scrapingDb
        .from('dim_noticias')
        .select('id, titulo, resumo, fonte_nome, data_publicacao, tema_principal, url')
        .in('id', noticiaIds)
        .order('data_publicacao', { ascending: false });
      noticias = data || [];
    }

    // 6. If no pre-computed associations, fallback: find noticias by same tema
    if (noticias.length === 0 && taxonomiaSlug) {
      const { data: temaMapping } = await scrapingDb
        .from('map_tema_taxonomia')
        .select('tema_principal')
        .eq('taxonomia_slug', taxonomiaSlug);

      if (temaMapping && temaMapping.length > 0) {
        const temas = temaMapping.map(t => t.tema_principal);
        const { data } = await scrapingDb
          .from('dim_noticias')
          .select('id, titulo, resumo, fonte_nome, data_publicacao, tema_principal, url')
          .in('tema_principal', temas)
          .order('data_publicacao', { ascending: false })
          .limit(5);
        noticias = data || [];
      }
    }

    // 7. Compute execution context for this emenda
    const valorEmpenhado = emenda.valor_empenhado || 0;
    const valorPago = emenda.valor_pago || 0;
    const taxaExecucao = valorEmpenhado > 0 ? Math.round((valorPago / valorEmpenhado) * 1000) / 10 : 0;
    const restoAPagar = (emenda.valor_resto_inscrito || 0) - (emenda.valor_resto_cancelado || 0) - (emenda.valor_resto_pago || 0);

    res.json({
      success: true,
      emenda_id: id,
      // Factual summary
      resumo: {
        autor: emenda.autor,
        partido: emenda.partido || null,
        funcao: emenda.funcao,
        subfuncao: emenda.subfuncao || null,
        tipo_emenda: emenda.tipo_emenda,
        localidade: emenda.localidade,
        ano: emenda.ano,
        is_pix: emenda.is_emenda_pix || false,
        codigo_ibge: emenda.codigo_ibge || null,
      },
      // Execution context
      execucao: {
        empenhado: valorEmpenhado,
        liquidado: emenda.valor_liquidado || 0,
        pago: valorPago,
        resto_a_pagar: restoAPagar,
        taxa_execucao: taxaExecucao,
      },
      // Taxonomy
      taxonomia,
      // Beneficiaries (top 10 for this emenda)
      favorecidos: (favorecidosResult.data || []).map(f => ({
        tipo: f.tipo_favorecido,
        nome: f.favorecido,
        uf: f.uf_favorecido,
        municipio: f.municipio_favorecido,
        valor: f.valor_recebido,
      })),
      // Author time series (may be null if RPC not deployed)
      autor_historico: autorHistoryResult.error ? null : (autorHistoryResult.data || []),
      // Related news
      associations_count: associations?.length || 0,
      noticias,
    });
  } catch (error) {
    logger.error('Error getting emenda context', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/emendas/:id
 * Get single emenda by ID
 */
router.get('/:id', validateParams(integerIdParamSchema), async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({
        success: false,
        error: 'Brasil Data Hub not configured. Set BRASIL_DATA_HUB_URL and BRASIL_DATA_HUB_KEY.'
      });
    }

    // ID already validated as integer by Zod
    const { id } = req.params;

    const { data: emenda, error } = await brasilDataHub
      .from('fato_emendas_parlamentares')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !emenda) {
      return res.status(404).json({ success: false, error: 'Emenda not found' });
    }

    res.json({
      success: true,
      emenda
    });

  } catch (error) {
    logger.error('Error getting emenda', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
