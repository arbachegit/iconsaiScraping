import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';

const router = Router();

// Cache in-memory para getAllCounts() — zero deps, TTL 30s
let countsCache = null;
let countsCacheTime = 0;
const COUNTS_CACHE_TTL = 30_000; // 30 segundos

async function getAllCountsCached() {
  const now = Date.now();
  if (countsCache && (now - countsCacheTime) < COUNTS_CACHE_TTL) {
    return countsCache;
  }
  const counts = await getAllCounts();
  countsCache = counts;
  countsCacheTime = now;
  return counts;
}

// Cliente Supabase para brasil-data-hub (políticos e mandatos)
const brasilDataHub = process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
  ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
  : null;

// Mapeamento categoria → { client, table, createdAtColumn }
// NOTA: dim_pessoas (não fato_pessoas) é a tabela real de pessoas
// brasil-data-hub usa 'criado_em' em vez de 'created_at'
function getCategoryMapping() {
  return {
    empresas: { client: supabase, table: 'dim_empresas', createdAtColumn: 'created_at' },
    pessoas: { client: supabase, table: 'dim_pessoas', createdAtColumn: 'created_at' },
    noticias: { client: supabase, table: 'fato_noticias', createdAtColumn: 'created_at' },
    politicos: { client: brasilDataHub, table: 'dim_politicos', createdAtColumn: 'criado_em' },
    mandatos: { client: brasilDataHub, table: 'fato_politicos_mandatos', createdAtColumn: 'criado_em' },
    emendas: { client: brasilDataHub, table: 'fato_emendas_parlamentares', createdAtColumn: 'criado_em' },
  };
}

/**
 * GET /stats
 * Returns counts for all main entities
 */
router.get('/', async (req, res) => {
  try {
    const localPromises = [
      supabase.from('dim_empresas').select('id', { count: 'estimated', head: true }),
      supabase.from('dim_pessoas').select('id', { count: 'estimated', head: true }),
      supabase.from('fato_noticias').select('id', { count: 'estimated', head: true }),
    ];

    const brasilDataHubPromises = brasilDataHub
      ? [
          brasilDataHub.from('dim_politicos').select('id', { count: 'estimated', head: true }),
          brasilDataHub.from('fato_politicos_mandatos').select('id', { count: 'estimated', head: true }),
          brasilDataHub.from('fato_emendas_parlamentares').select('id', { count: 'estimated', head: true }),
        ]
      : [Promise.resolve({ count: 0 }), Promise.resolve({ count: 0 }), Promise.resolve({ count: 0 })];

    const [empresas, pessoas, noticias, politicos, mandatos, emendas] = await Promise.all([
      ...localPromises,
      ...brasilDataHubPromises,
    ]);

    const stats = {
      empresas: empresas.count || 0,
      pessoas: pessoas.count || 0,
      politicos: politicos.count || 0,
      mandatos: mandatos.count || 0,
      emendas: emendas.count || 0,
      noticias: noticias.count || 0,
    };

    logger.info('Stats fetched', stats);

    res.json({
      success: true,
      stats,
      sources: {
        local: ['empresas', 'pessoas', 'noticias'],
        brasil_data_hub: brasilDataHub ? ['politicos', 'mandatos', 'emendas'] : [],
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
    const { count, error } = await client.from(table).select('id', { count: 'estimated', head: true });
    if (error) {
      logger.warn('safeCount error', { table, error: error.message });
      return 0;
    }
    return count || 0;
  } catch (err) {
    logger.error('safeCount exception', { table, error: err.message });
    return 0;
  }
}

/**
 * Helper: get all current counts
 */
async function getAllCounts() {
  const [empresas, pessoas, noticias] = await Promise.all([
    safeCount(supabase, 'dim_empresas'),
    safeCount(supabase, 'dim_pessoas'),
    safeCount(supabase, 'fato_noticias'),
  ]);

  let politicos = 0;
  let mandatos = 0;
  let emendas = 0;
  if (brasilDataHub) {
    [politicos, mandatos, emendas] = await Promise.all([
      safeCount(brasilDataHub, 'dim_politicos'),
      safeCount(brasilDataHub, 'fato_politicos_mandatos'),
      safeCount(brasilDataHub, 'fato_emendas_parlamentares'),
    ]);
  }

  return { empresas, pessoas, politicos, mandatos, emendas, noticias };
}

/**
 * Count rows created on a specific day for a table.
 * Uses UTC day boundaries (00:00 - 00:00 next day).
 * @param {object} client - Supabase client
 * @param {string} table - Table name
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {string} createdAtColumn - Column name for creation timestamp (default: 'created_at')
 */
async function countDayInserts(client, table, dateStr, createdAtColumn = 'created_at') {
  try {
    const dayStart = dateStr + 'T00:00:00.000Z';
    const nextDay = new Date(dateStr + 'T00:00:00.000Z');
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const dayEnd = nextDay.toISOString();

    const { count } = await client
      .from(table)
      .select('id', { count: 'estimated', head: true })
      .gte(createdAtColumn, dayStart)
      .lt(createdAtColumn, dayEnd);

    return count || 0;
  } catch {
    return 0;
  }
}

/**
 * Fill date gaps carrying forward the last known total (for cumulative charts).
 * Input: array of {data, total} sorted ascending.
 * Output: array of {data, value} with no gaps, monotonically increasing.
 */
function fillDateGapsCumulative(points) {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ data: points[0].data, value: points[0].total }];

  const map = new Map(points.map(p => [p.data, p.total]));
  const start = new Date(points[0].data + 'T00:00:00Z');
  const end = new Date(points[points.length - 1].data + 'T00:00:00Z');

  const result = [];
  const current = new Date(start);
  let lastKnown = points[0].total;

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    if (map.has(dateStr)) {
      lastKnown = map.get(dateStr);
    }
    result.push({ data: dateStr, value: lastKnown });
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
    const counts = await getAllCountsCached();

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
      ['emendas', counts.emendas],
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
 * Returns CUMULATIVE (accumulated total) series from stats_historico.
 * The chart is cumulative — monotonically increasing, never a plateau.
 * Each point.value = accumulated total at that date.
 * Also includes today's inserts and period growth for the footer.
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

    // Get current counts for today's live data
    const counts = await getAllCountsCached();
    const hojeISO = new Date().toISOString().split('T')[0];

    // Build response: points contain cumulative totals directly
    const historico = {};
    for (const [cat, accumulated] of Object.entries(rawByCategory)) {
      // Fill date gaps with interpolated values (carry forward last known total)
      const filled = fillDateGapsCumulative(accumulated);

      // Today's inserts = current live count - last snapshot total
      const lastSnapshotTotal = accumulated.length > 0
        ? accumulated[accumulated.length - 1].total
        : 0;
      const currentTotal = counts[cat] || 0;
      const todayInserts = Math.max(0, currentTotal - lastSnapshotTotal);

      // Ensure today is in the series with live count
      const lastPointDate = filled.length > 0
        ? filled[filled.length - 1].data
        : null;

      if (lastPointDate === hojeISO) {
        // Update today's point with live count (may be higher than snapshot)
        filled[filled.length - 1].value = Math.max(
          filled[filled.length - 1].value,
          currentTotal
        );
      } else if (filled.length > 0) {
        // Fill gap from last date to today, carrying forward the total
        const lastDate = new Date(lastPointDate + 'T00:00:00Z');
        const todayDate = new Date(hojeISO + 'T00:00:00Z');
        const lastTotal = filled[filled.length - 1].value;
        const next = new Date(lastDate);
        next.setUTCDate(next.getUTCDate() + 1);
        while (next < todayDate) {
          filled.push({ data: next.toISOString().split('T')[0], value: lastTotal });
          next.setUTCDate(next.getUTCDate() + 1);
        }
        filled.push({ data: hojeISO, value: currentTotal });
      }

      // Period growth = newest total - oldest total
      const periodGrowth = filled.length >= 2
        ? filled[filled.length - 1].value - filled[0].value
        : 0;

      historico[cat] = {
        unit: 'registros',
        timezone: 'America/Sao_Paulo',
        today: todayInserts,
        periodTotal: periodGrowth,
        points: filled,
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
 *
 * REGRA: Monotonically increasing — o total NUNCA pode diminuir.
 * PostgreSQL 'estimated' count flutua em tabelas grandes (40M+),
 * então protegemos contra quedas falsas comparando com o último snapshot.
 */
router.post('/snapshot', async (req, res) => {
  try {
    const counts = await getAllCountsCached();
    const hojeISO = new Date().toISOString().split('T')[0];

    // Buscar snapshots existentes de hoje (ou do último dia disponível)
    const { data: existingToday } = await supabase
      .from('stats_historico')
      .select('categoria, total')
      .eq('data', hojeISO);

    const existingTotals = {};
    for (const row of existingToday || []) {
      existingTotals[row.categoria] = row.total;
    }

    // Se não tiver dados de hoje, buscar o último snapshot conhecido
    if (Object.keys(existingTotals).length === 0) {
      const { data: lastSnaps } = await supabase
        .from('stats_historico')
        .select('categoria, total')
        .lt('data', hojeISO)
        .order('data', { ascending: false })
        .limit(10);

      for (const row of lastSnaps || []) {
        if (!existingTotals[row.categoria]) {
          existingTotals[row.categoria] = row.total;
        }
      }
    }

    const categories = ['empresas', 'pessoas', 'politicos', 'mandatos', 'emendas', 'noticias'];
    const snapshots = [];

    for (const cat of categories) {
      const currentEstimate = counts[cat] || 0;
      const previousTotal = existingTotals[cat] || 0;

      // REGRA: nunca diminuir (estimated count flutua)
      const total = Math.max(currentEstimate, previousTotal);

      snapshots.push({ data: hojeISO, categoria: cat, total });

      if (currentEstimate < previousTotal) {
        logger.warn('Estimated count dropped (protected)', {
          categoria: cat,
          estimated: currentEstimate,
          previous: previousTotal,
          kept: total,
        });
      }
    }

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

/**
 * POST /stats/backfill
 * Populates stats_historico with historical accumulated totals.
 *
 * Strategy:
 * 1. Get current total for each category (live count)
 * 2. Count daily inserts via created_at for last N days
 * 3. Build accumulated totals backwards:
 *    - today = current_total
 *    - yesterday = current_total - today_inserts
 *    - day_before = yesterday_total - yesterday_inserts
 * 4. Upsert all into stats_historico
 */
router.post('/backfill', async (req, res) => {
  try {
    const { days = 30 } = req.body || {};
    const numDays = Math.min(Math.max(parseInt(days, 10) || 30, 7), 365);

    logger.info('Starting stats backfill', { days: numDays });

    const counts = await getAllCounts();
    const mapping = getCategoryMapping();
    const categories = ['empresas', 'pessoas', 'noticias', 'politicos', 'mandatos', 'emendas'];

    // Build list of dates (last N days)
    const dates = [];
    const now = new Date();
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const results = {};
    let totalUpserted = 0;

    for (const cat of categories) {
      const { client, table, createdAtColumn } = mapping[cat];

      if (!client) {
        logger.warn(`Backfill: no client for ${cat}, skipping`);
        results[cat] = { skipped: true, reason: 'no client' };
        continue;
      }

      // Count daily inserts for each date via created_at/criado_em
      const dailyInsertsPromises = dates.map(dateStr =>
        countDayInserts(client, table, dateStr, createdAtColumn).then(count => ({ date: dateStr, count }))
      );

      const dailyInserts = await Promise.all(dailyInsertsPromises);

      // Build accumulated totals backwards from current count
      const currentTotal = counts[cat] || 0;
      const snapshots = [];
      let runningTotal = currentTotal;

      // Process from most recent to oldest
      const sortedDesc = [...dailyInserts].sort((a, b) => b.date.localeCompare(a.date));

      for (const { date, count } of sortedDesc) {
        snapshots.push({ data: date, categoria: cat, total: runningTotal });
        runningTotal = Math.max(0, runningTotal - count);
      }

      // Upsert all snapshots (batch of 50 for safety)
      for (let i = 0; i < snapshots.length; i += 50) {
        const batch = snapshots.slice(i, i + 50);
        for (const snap of batch) {
          const { error } = await supabase
            .from('stats_historico')
            .upsert(snap, { onConflict: 'data,categoria' });

          if (error) {
            logger.warn('Backfill upsert failed', { snap, error: error.message });
          } else {
            totalUpserted++;
          }
        }
      }

      // Log sample for this category
      const oldest = snapshots[snapshots.length - 1];
      const newest = snapshots[0];
      results[cat] = {
        days: snapshots.length,
        currentTotal,
        oldestDate: oldest?.data,
        oldestTotal: oldest?.total,
        newestDate: newest?.data,
        newestTotal: newest?.total,
      };

      logger.info(`Backfill ${cat}`, results[cat]);
    }

    logger.info('Stats backfill complete', { totalUpserted, days: numDays });

    res.json({
      success: true,
      message: `Backfill completo: ${totalUpserted} registros em ${numDays} dias`,
      days: numDays,
      totalUpserted,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error in stats backfill', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to backfill stats',
    });
  }
});

/**
 * GET /stats/diagnostic
 * Returns per-category count, latency, errors, and cache status.
 */
router.get('/diagnostic', async (req, res) => {
  try {
    const results = {};
    const mapping = getCategoryMapping();

    for (const [cat, { client, table }] of Object.entries(mapping)) {
      if (!client) {
        results[cat] = { table, count: 0, error: 'no client configured', latency_ms: 0 };
        continue;
      }
      const start = Date.now();
      try {
        const { count, error } = await client.from(table).select('id', { count: 'estimated', head: true });
        results[cat] = {
          table,
          count: count || 0,
          error: error?.message || null,
          latency_ms: Date.now() - start,
          client: client === brasilDataHub ? 'brasil_data_hub' : 'local',
        };
      } catch (err) {
        results[cat] = { table, count: 0, error: err.message, latency_ms: Date.now() - start };
      }
    }

    // Historico count por categoria
    const { data: hist } = await supabase
      .from('stats_historico')
      .select('categoria')
      .order('data', { ascending: false })
      .limit(100);

    const histCount = {};
    for (const row of hist || []) {
      histCount[row.categoria] = (histCount[row.categoria] || 0) + 1;
    }

    res.json({
      success: true,
      categories: results,
      stats_historico_rows: histCount,
      cache_age_ms: countsCacheTime > 0 ? Date.now() - countsCacheTime : null,
    });
  } catch (error) {
    logger.error('Error in stats diagnostic', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to run diagnostic' });
  }
});

export default router;
