import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';

const router = Router();

// Cliente Supabase para brasil-data-hub (políticos e mandatos)
const brasilDataHub = process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
  ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
  : null;

/**
 * GET /stats
 * Returns counts for all main entities
 * - empresas, pessoas, noticias: from local Supabase
 * - politicos, mandatos: from brasil-data-hub
 */
router.get('/', async (req, res) => {
  try {
    // Local Supabase counts - use 'estimated' for large tables to avoid timeout
    const localPromises = [
      supabase.from('dim_empresas').select('id', { count: 'estimated', head: true }),
      supabase.from('fato_pessoas').select('id', { count: 'estimated', head: true }),
      supabase.from('fato_noticias').select('id', { count: 'estimated', head: true }),
    ];

    // Brasil Data Hub counts (if configured) - use 'estimated' for large tables
    const brasilDataHubPromises = brasilDataHub
      ? [
          brasilDataHub.from('dim_politicos').select('id', { count: 'estimated', head: true }),
          brasilDataHub.from('fato_politicos_mandatos').select('id', { count: 'estimated', head: true }),
        ]
      : [Promise.resolve({ count: 0 }), Promise.resolve({ count: 0 })];

    const [empresas, pessoas, noticias, politicos, mandatos] = await Promise.all([
      ...localPromises,
      ...brasilDataHubPromises,
    ]);

    const stats = {
      empresas: empresas.count || 0,
      pessoas: pessoas.count || 0,
      politicos: politicos.count || 0,
      mandatos: mandatos.count || 0,
      noticias: noticias.count || 0,
    };

    logger.info('Stats fetched', stats);

    res.json({
      success: true,
      stats,
      sources: {
        local: ['empresas', 'pessoas', 'noticias'],
        brasil_data_hub: brasilDataHub ? ['politicos', 'mandatos'] : [],
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch stats',
    });
  }
});

/**
 * Helper: safe count for a table (returns 0 on error)
 */
async function safeCount(client, table) {
  try {
    const { count } = await client.from(table).select('id', { count: 'estimated', head: true });
    return count || 0;
  } catch {
    return 0;
  }
}

/**
 * Helper: get all current counts
 */
async function getAllCounts() {
  const [empresas, pessoas, noticias] = await Promise.all([
    safeCount(supabase, 'dim_empresas'),
    safeCount(supabase, 'fato_pessoas'),
    safeCount(supabase, 'fato_noticias'),
  ]);

  let politicos = 0;
  let mandatos = 0;
  if (brasilDataHub) {
    [politicos, mandatos] = await Promise.all([
      safeCount(brasilDataHub, 'dim_politicos'),
      safeCount(brasilDataHub, 'fato_politicos_mandatos'),
    ]);
  }

  return { empresas, pessoas, politicos, mandatos, noticias };
}

/**
 * GET /stats/current
 * Returns current counts + growth percentages vs yesterday.
 * Used by dashboard badge cards.
 */
router.get('/current', async (req, res) => {
  try {
    const counts = await getAllCounts();

    // Yesterday's date
    const hoje = new Date();
    const ontem = new Date(hoje);
    ontem.setDate(ontem.getDate() - 1);
    const ontemISO = ontem.toISOString().split('T')[0];
    const hojeISO = hoje.toISOString().split('T')[0];

    // Fetch yesterday's snapshot
    const { data: historicoOntem } = await supabase
      .from('stats_historico')
      .select('*')
      .eq('data', ontemISO);

    const ontemDict = {};
    for (const row of historicoOntem || []) {
      ontemDict[row.categoria] = row.total;
    }

    // Build response with growth
    const categorias = [
      ['empresas', counts.empresas],
      ['pessoas', counts.pessoas],
      ['politicos', counts.politicos],
      ['mandatos', counts.mandatos],
      ['noticias', counts.noticias],
    ];

    const stats = categorias.map(([cat, total]) => {
      const totalOntem = ontemDict[cat] ?? total;
      const crescimento = totalOntem > 0
        ? Math.round(((total - totalOntem) / totalOntem) * 10000) / 100
        : 0;

      return {
        categoria: cat,
        total,
        total_ontem: totalOntem,
        crescimento_percentual: crescimento,
      };
    });

    res.json({
      success: true,
      stats,
      data_referencia: hojeISO,
      online: true,
      proxima_atualizacao_segundos: 300,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching current stats', { error: error.message });
    res.status(500).json({
      success: false,
      stats: [],
      data_referencia: new Date().toISOString().split('T')[0],
      online: false,
      error: 'Failed to fetch current stats',
    });
  }
});

/**
 * GET /stats/history
 * Returns historical stats for charts.
 * Query params: categoria (optional), limit (default 365)
 */
router.get('/history', async (req, res) => {
  try {
    const { categoria, limit = '365' } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 365, 1), 1000);

    let query = supabase
      .from('stats_historico')
      .select('*')
      .order('data', { ascending: true })
      .limit(limitNum);

    if (categoria) {
      query = query.eq('categoria', categoria);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Group by category
    const historico = {};
    for (const row of data || []) {
      const cat = row.categoria;
      if (!historico[cat]) historico[cat] = [];
      historico[cat].push({
        data: row.data,
        total: row.total,
      });
    }

    res.json({
      success: true,
      historico,
      categorias: Object.keys(historico),
      total_registros: (data || []).length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching stats history', { error: error.message });
    res.status(500).json({
      success: false,
      historico: {},
      categorias: [],
      total_registros: 0,
      error: 'Failed to fetch stats history',
    });
  }
});

/**
 * POST /stats/snapshot
 * Creates a snapshot of current counts in stats_historico.
 * Called by dashboard on load and on each refresh cycle.
 */
router.post('/snapshot', async (req, res) => {
  try {
    const counts = await getAllCounts();
    const hojeISO = new Date().toISOString().split('T')[0];

    const snapshots = [
      { data: hojeISO, categoria: 'empresas', total: counts.empresas },
      { data: hojeISO, categoria: 'pessoas', total: counts.pessoas },
      { data: hojeISO, categoria: 'politicos', total: counts.politicos },
      { data: hojeISO, categoria: 'mandatos', total: counts.mandatos },
      { data: hojeISO, categoria: 'noticias', total: counts.noticias },
    ];

    for (const snap of snapshots) {
      const { error } = await supabase
        .from('stats_historico')
        .upsert(snap, { onConflict: 'data,categoria' });

      if (error) {
        logger.warn('Snapshot upsert failed', { snap, error: error.message });
      }
    }

    logger.info('Stats snapshot created', { date: hojeISO, counts });

    res.json({
      success: true,
      message: `Snapshot criado para ${hojeISO}`,
      data: hojeISO,
      counts,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error creating stats snapshot', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to create stats snapshot',
    });
  }
});

export default router;
