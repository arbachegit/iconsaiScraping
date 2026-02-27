/**
 * Backfill stats_historico table
 *
 * Since tables are massive (5M+ pessoas, 2M+ politicos, 4M+ mandatos)
 * and Supabase has statement timeouts, we use:
 *   1. Estimated counts (same as stats endpoint)
 *   2. Known data availability dates from git history
 *
 * Usage: cd backend && node scripts/backfill_stats_historico.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const brasilDataHub = process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
  ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
  : null;

/**
 * Known data availability dates from git history:
 * - 2026-02-04: Project created, no data yet
 * - 2026-02-05: DB persistence added, bulk imports started
 * - 2026-02-05: People + Politicians analysis integrated
 * - 2026-02-06: Frontend deployed
 * - 2026-02-23: stats_historico table created
 */
const DATA_AVAILABILITY = {
  empresas: '2026-02-05',
  pessoas: '2026-02-05',
  noticias: '2026-02-16', // Migration 010 created noticias schema on 2026-02-16
  politicos: '2026-02-05',
  mandatos: '2026-02-05',
  emendas: '2026-02-27', // Primeira data com emendas no stats
};

function getDateRange() {
  const dates = [];
  const start = new Date('2026-02-04T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const current = new Date(start);
  while (current <= today) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

async function safeEstimatedCount(client, table) {
  try {
    const { count, error } = await client
      .from(table)
      .select('id', { count: 'estimated', head: true });
    if (error) {
      console.error(`  [${table}] estimated count error:`, error.message);
      return 0;
    }
    return count || 0;
  } catch (err) {
    console.error(`  [${table}] exception:`, err.message);
    return 0;
  }
}

async function upsertSnapshot(date, categoria, total) {
  const { error } = await supabase
    .from('stats_historico')
    .upsert(
      { data: date, categoria, total },
      { onConflict: 'data,categoria' }
    );
  if (error) {
    console.error(`  Upsert error ${date}/${categoria}:`, error.message);
    return false;
  }
  return true;
}

async function main() {
  console.log('=== Backfill stats_historico ===\n');

  const dates = getDateRange();
  console.log(`Date range: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)\n`);

  // Get current totals using estimated counts (same as stats endpoint)
  console.log('Fetching current totals (estimated)...');

  const totals = {
    empresas: await safeEstimatedCount(supabase, 'dim_empresas'),
    pessoas: await safeEstimatedCount(supabase, 'fato_pessoas'),
    noticias: await safeEstimatedCount(supabase, 'fato_noticias'),
    politicos: brasilDataHub ? await safeEstimatedCount(brasilDataHub, 'dim_politicos') : 0,
    mandatos: brasilDataHub ? await safeEstimatedCount(brasilDataHub, 'fato_politicos_mandatos') : 0,
    emendas: brasilDataHub ? await safeEstimatedCount(brasilDataHub, 'fato_emendas_parlamentares') : 0,
  };

  console.log('');
  for (const [cat, total] of Object.entries(totals)) {
    const available = DATA_AVAILABILITY[cat];
    console.log(`  ${cat}: ${total.toLocaleString()} (available from ${available})`);
  }

  // Backfill: for each date, set total to current total if date >= availability date, else 0
  console.log('\n--- Inserting snapshots ---\n');

  let inserted = 0;
  for (const date of dates) {
    const row = {};
    for (const [cat, total] of Object.entries(totals)) {
      row[cat] = date >= DATA_AVAILABILITY[cat] ? total : 0;
    }

    const parts = Object.entries(row)
      .map(([k, v]) => `${k}=${v.toLocaleString()}`)
      .join(' ');
    process.stdout.write(`  ${date}: ${parts}`);

    let ok = true;
    for (const [cat, total] of Object.entries(row)) {
      const success = await upsertSnapshot(date, cat, total);
      if (!success) ok = false;
    }

    console.log(ok ? ' ✓' : ' ✗');
    inserted++;
  }

  console.log(`\n=== Done ===`);
  console.log(`  Days: ${inserted}`);
  console.log(`  Snapshots: ${inserted * Object.keys(totals).length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
