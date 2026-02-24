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
 */
router.get('/', async (req, res) => {
  try {
    const localPromises = [
      supabase.from('dim_empresas').select('id', { count: 'estimated', head: true }),
      supabase.from('fato_pessoas').select('id', { count: 'estimated', head: true }),
      supabase.from('fato_noticias').select('id', { count: 'estimated', head: true }),
    ];

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
 * Compute daily inserts from accumulated totals.
 * Input: array of {data, total} sorted ascending by date.
 * Output: array of {data, value} where value = inserts that day.
 * First data point gets value=0 (baseline).
 */
function computeDailyInserts(accumulatedPoints) {
  if (accumulatedPoints.length === 0) return [];

  const result = [];
  // First point is the baseline — no prior to diff against
  result.push({ data: accumulatedPoints[0].data, value: 0 });

  for (let i = 1; i < accumulatedPoints.length; i++) {
    const diff = accumulatedPoints[i].total - accumulatedPoints[i - 1].total;
    result.push({ data: accumulatedPoints[i].data, value: Math.max(0, diff) });
  }

  return result;
}

/**
 * Fill date gaps with value=0.
 * Input: array of {data, value} with possible missing days.
 * Output: continuous daily series with no gaps.
 */
function fillDateGaps(points) {
  if (points.length < 2) return points;

  const map = new Map(points.map(p => [p.data, p.value]));
  const start = new Date(points[0].data + 'T00:00:00Z');
  const end = new Date(points[points.length - 1].data + 'T00:00:00Z');

  const result = [];
  const current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    result.push({ data: dateStr, value: map.get(dateStr) ?? 0 });
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return result;
}

/**
 * GET /stats/current
 * Returns current counts + today's inserts + growth.
 */
router.get('/current', async (req, res) => {
  try {
    const counts = await getAllCounts();

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

    const categorias = [
      ['empresas', counts.empresas],
      ['pessoas', counts.pessoas],
      ['politicos', counts.politicos],
      ['mandatos', counts.mandatos],
      ['noticias', counts.noticias],
    ];

    const stats = categorias.map(([cat, total]) => {
      const totalOntem = ontemDict[cat] ?? total;
      const todayInserts = Math.max(0, total - totalOntem);
      const crescimento = totalOntem > 0
        ? Math.round(((total - totalOntem) / totalOntem) * 10000) / 100
        : 0;

      return {
        categoria: cat,
        total,
        total_ontem: totalOntem,
        today_inserts: todayInserts,
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
 * Returns daily inserts series computed from accumulated snapshots.
 * Each category includes: unit, timezone, today inserts, period total, data points.
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

    // Group accumulated totals by category
    const rawByCategory = {};
    for (const row of data || []) {
      const cat = row.categoria;
      if (!rawByCategory[cat]) rawByCategory[cat] = [];
      rawByCategory[cat].push({ data: row.data, total: row.total });
    }

    // Get current counts for today's inserts
    const counts = await getAllCounts();
    const hojeISO = new Date().toISOString().split('T')[0];

    // Build response with daily inserts per category
    const historico = {};
    for (const [cat, accumulated] of Object.entries(rawByCategory)) {
      // Compute daily inserts from consecutive diffs
      const dailyRaw = computeDailyInserts(accumulated);

      // Fill gaps with 0
      const dailyFilled = fillDateGaps(dailyRaw);

      // Compute today's inserts from live count vs last snapshot
      const lastAccumulated = accumulated.length > 0
        ? accumulated[accumulated.length - 1].total
        : 0;
      const currentTotal = counts[cat] || 0;
      const todayInserts = Math.max(0, currentTotal - lastAccumulated);

      // If today's date is already in the series, update it with live value
      // Otherwise append it
      const lastPointDate = dailyFilled.length > 0
        ? dailyFilled[dailyFilled.length - 1].data
        : null;

      if (lastPointDate === hojeISO) {
        // Update today's point with live diff
        dailyFilled[dailyFilled.length - 1].value = Math.max(
          dailyFilled[dailyFilled.length - 1].value,
          todayInserts
        );
      } else if (dailyFilled.length > 0) {
        // Fill gap from last date to today with 0s, then set today
        const lastDate = new Date(lastPointDate + 'T00:00:00Z');
        const todayDate = new Date(hojeISO + 'T00:00:00Z');
        const next = new Date(lastDate);
        next.setUTCDate(next.getUTCDate() + 1);
        while (next < todayDate) {
          dailyFilled.push({ data: next.toISOString().split('T')[0], value: 0 });
          next.setUTCDate(next.getUTCDate() + 1);
        }
        dailyFilled.push({ data: hojeISO, value: todayInserts });
      }

      const periodTotal = dailyFilled.reduce((sum, p) => sum + p.value, 0);

      historico[cat] = {
        unit: 'registros/dia',
        timezone: 'America/Sao_Paulo',
        today: todayInserts,
        periodTotal,
        points: dailyFilled,
      };
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
 * Creates a snapshot of current accumulated counts in stats_historico.
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
