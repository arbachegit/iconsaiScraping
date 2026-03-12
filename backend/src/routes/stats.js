import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { cacheGet, cacheSet, CACHE_TTL, getCacheStats } from '../utils/cache.js';
import { STATS_TIMEZONE, STATS_UTC_OFFSET } from '../constants.js';
import { syncGraphRelationships } from '../services/graph-sync.js';
import { syncBiToGraph } from '../services/bi-graph-sync.js';

const router = Router();

// Timezone helper — sempre usar horário de São Paulo (BRT/BRST)
const BRT_FORMATTER = new Intl.DateTimeFormat('sv-SE', { timeZone: STATS_TIMEZONE });

function getDateBRT(date = new Date()) {
  return BRT_FORMATTER.format(date); // returns 'YYYY-MM-DD'
}

// Cache via Redis (with in-memory fallback) — TTL 10min (exact counts are slow)
async function getAllCountsCached() {
  const cacheKey = 'stats:all_counts';
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const counts = await getAllCounts();
  await cacheSet(cacheKey, counts, CACHE_TTL.STATS);
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
    noticias: { client: supabase, table: 'dim_noticias', createdAtColumn: 'created_at' },
    politicos: { client: brasilDataHub, table: 'dim_politicos', createdAtColumn: 'criado_em' },
    mandatos: { client: brasilDataHub, table: 'fato_politicos_mandatos', createdAtColumn: 'criado_em' },
    emendas: { client: brasilDataHub, table: 'fato_emendas_parlamentares', createdAtColumn: 'criado_em' },
    emendas_subnacionais: { client: brasilDataHub, table: 'fato_emendas_subnacionais', createdAtColumn: 'criado_em' },
  };
}

/**
 * GET /stats
 * Returns counts for all main entities
 */
router.get('/', async (req, res) => {
  try {
    const [empresas, pessoas, noticias] = await Promise.all([
      safeCount(supabase, 'dim_empresas'),
      safeCount(supabase, 'dim_pessoas'),
      safeCount(supabase, 'dim_noticias'),
    ]);

    let politicos = 0, mandatos = 0, emendas = 0;
    if (brasilDataHub) {
      let emendasFederais = 0, emendasSubnacionais = 0;
      [politicos, mandatos, emendasFederais, emendasSubnacionais] = await Promise.all([
        safeCount(brasilDataHub, 'dim_politicos'),
        safeCount(brasilDataHub, 'fato_politicos_mandatos'),
        safeCount(brasilDataHub, 'fato_emendas_parlamentares'),
        safeCount(brasilDataHub, 'fato_emendas_subnacionais'),
      ]);
      emendas = emendasFederais + emendasSubnacionais;
    }

    const stats = { empresas, pessoas, politicos, mandatos, emendas, noticias };

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

// ==========================================================================
// GOLDEN RULE 5: Stats Count Pipeline (IMMUTABLE)
//
// safeCount: exact → estimated fallback (large tables timeout on exact)
// getAllCounts: parallel counts for all 6 categories
//
// DO NOT remove the estimated fallback — empresas/mandatos need it.
// DO NOT change the 6 categories or their table mappings.
// DO NOT add refetchInterval or cron logic here — load once per session.
// ==========================================================================

/**
 * Fast count via pg_class (instant, no table scan).
 * Uses RPC count_empresas_estimate for dim_empresas, or direct pg_class query.
 * Falls back to Supabase estimated/exact count for other tables.
 */
async function safeCount(client, table) {
  try {
    // 1. For dim_empresas: use dedicated RPC (reads pg_class directly, instant)
    if (table === 'dim_empresas') {
      const { data, error } = await client.rpc('count_empresas_estimate', {});
      if (!error && data != null && data > 0) {
        return data;
      }
      logger.warn('safeCount RPC failed for dim_empresas', { error: error?.message });
    }

    // 2. Estimated count (pg_class reltuples via PostgREST, works on most tables)
    const { count: estimated, error: estError } = await client.from(table).select('id', { count: 'estimated', head: true });
    if (!estError && estimated != null && estimated > 0) {
      return estimated;
    }

    // 3. Exact count (only for small tables where estimated returns 0)
    logger.info('safeCount estimated returned 0, trying exact', { table, estimated, error: estError?.message });
    const { count, error } = await client.from(table).select('id', { count: 'exact', head: true });
    if (!error && count != null) {
      return count;
    }

    logger.warn('safeCount all methods failed', { table, error: error?.message });
    return 0;
  } catch (err) {
    logger.error('safeCount exception', { table, error: err.message });
    return 0;
  }
}

/**
 * Get all current counts — 6 categories, parallel.
 */
async function getAllCounts() {
  const [empresas, pessoas, noticias] = await Promise.all([
    safeCount(supabase, 'dim_empresas'),
    safeCount(supabase, 'dim_pessoas'),
    safeCount(supabase, 'dim_noticias'),
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
// ======================== END GOLDEN RULE 5 ==============================

/**
 * Count rows created on a specific day for a table.
 * Uses BRT day boundaries (midnight São Paulo = 03:00 UTC).
 * @param {object} client - Supabase client
 * @param {string} table - Table name
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {string} createdAtColumn - Column name for creation timestamp (default: 'created_at')
 */
async function countDayInserts(client, table, dateStr, createdAtColumn = 'created_at') {
  try {
    const dayStart = dateStr + STATS_UTC_OFFSET;
    const nextDay = new Date(dateStr + STATS_UTC_OFFSET);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const dayEnd = nextDay.toISOString();

    const { count } = await client
      .from(table)
      .select('id', { count: 'exact', head: true })
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
    const hojeISO = getDateBRT(hoje);
    const ontem = new Date(hoje);
    ontem.setDate(ontem.getDate() - 1);
    const ontemISO = getDateBRT(ontem);

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
      data_referencia: getDateBRT(),
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
    const hojeISO = getDateBRT();

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
        timezone: STATS_TIMEZONE,
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

// ==========================================================================
// GOLDEN RULE 5 (cont.): Snapshot Endpoint (IMMUTABLE)
//
// POST /stats/snapshot — writes to stats_historico
// REGRA: Monotonically increasing — o total NUNCA pode diminuir.
// Math.max(currentEstimate, previousTotal) ensures only upward movement.
//
// DO NOT remove the monotonic protection (Math.max).
// DO NOT change the 6 categories array.
// DO NOT remove the graph sync trigger.
// ==========================================================================
router.post('/snapshot', async (req, res) => {
  try {
    const counts = await getAllCountsCached();
    const hojeISO = getDateBRT();

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

    // Trigger graph sync in background (non-blocking)
    // Finds new empresas without relationships and enriches them
    syncGraphRelationships()
      .then(syncResult => {
        if (syncResult.processed > 0) {
          logger.info('graph_sync_via_snapshot', syncResult);
        }
      })
      .catch(err => {
        logger.warn('graph_sync_via_snapshot_error', { error: err.message });
      });

    // Trigger BI → Graph sync in background (non-blocking)
    // Syncs ecosystem relationships and high-score opportunities to the graph
    syncBiToGraph()
      .then(biResult => {
        if (biResult.synced > 0 || biResult.opportunities_synced > 0) {
          logger.info('bi_graph_sync_via_snapshot', biResult);
        }
      })
      .catch(err => {
        logger.warn('bi_graph_sync_via_snapshot_error', { error: err.message });
      });

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
      dates.push(getDateBRT(d));
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
        const { count, error } = await client.from(table).select('id', { count: 'exact', head: true });
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

    const cacheInfo = await getCacheStats();

    res.json({
      success: true,
      categories: results,
      stats_historico_rows: histCount,
      cache: cacheInfo,
    });
  } catch (error) {
    logger.error('Error in stats diagnostic', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to run diagnostic' });
  }
});

export default router;
