/**
 * REBUILD stats_historico com dados REAIS
 *
 * Estrategia:
 * 1. Deleta TODOS os dados existentes de stats_historico
 * 2. Para cada tabela de origem, conta inserts por dia via created_at/criado_em
 * 3. Calcula totais acumulados (cumulative) por dia
 * 4. Insere APENAS dados reais na stats_historico
 *
 * NOTA: Usa 'estimated' count com filtro de data (mais rapido que 'exact')
 *       Para tabelas de 40M+ registros, 'exact' causa timeout no Supabase
 *
 * Usage: cd backend && node scripts/rebuild_stats_historico.js
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brasilDataHub = createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY);

// Mapeamento correto (dim_pessoas, criado_em para brasil-data-hub)
const CATEGORY_MAP = {
  empresas: { client: supabase, table: 'dim_empresas', col: 'created_at' },
  pessoas: { client: supabase, table: 'dim_pessoas', col: 'created_at' },
  noticias: { client: supabase, table: 'fato_noticias', col: 'created_at' },
  politicos: { client: brasilDataHub, table: 'dim_politicos', col: 'criado_em' },
  mandatos: { client: brasilDataHub, table: 'fato_politicos_mandatos', col: 'criado_em' },
  emendas: { client: brasilDataHub, table: 'fato_emendas_parlamentares', col: 'criado_em' },
};

async function safeEstimatedCount(client, table) {
  try {
    const { count } = await client.from(table).select('id', { count: 'estimated', head: true });
    return count || 0;
  } catch {
    return 0;
  }
}

async function countDayInserts(client, table, dateStr, col) {
  try {
    const dayStart = dateStr + 'T00:00:00.000Z';
    const nextDay = new Date(dateStr + 'T00:00:00.000Z');
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const dayEnd = nextDay.toISOString();

    const { count } = await client
      .from(table)
      .select('id', { count: 'estimated', head: true })
      .gte(col, dayStart)
      .lt(col, dayEnd);

    return count || 0;
  } catch {
    return 0;
  }
}

function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

async function main() {
  console.log('=== REBUILD stats_historico COM DADOS REAIS ===\n');

  // 1. Buscar totais atuais (referencia)
  console.log('1. Buscando totais atuais...\n');
  const currentTotals = {};
  for (const [cat, { client, table }] of Object.entries(CATEGORY_MAP)) {
    currentTotals[cat] = await safeEstimatedCount(client, table);
    console.log(`  ${cat}: ${currentTotals[cat].toLocaleString()} (${table})`);
  }

  // 2. Definir range de datas (desde o primeiro import conhecido)
  const today = new Date().toISOString().split('T')[0];
  const startDate = '2026-02-17'; // Primeiro import real (dim_politicos)
  const dates = getDateRange(startDate, today);
  console.log(`\n2. Range: ${startDate} -> ${today} (${dates.length} dias)\n`);

  // 3. Contar inserts por dia por categoria
  console.log('3. Contando inserts diarios por categoria...\n');
  const dailyInserts = {};

  for (const [cat, { client, table, col }] of Object.entries(CATEGORY_MAP)) {
    console.log(`  --- ${cat} (${table}.${col}) ---`);
    dailyInserts[cat] = {};

    for (const dateStr of dates) {
      const count = await countDayInserts(client, table, dateStr, col);
      if (count > 0) {
        dailyInserts[cat][dateStr] = count;
        console.log(`    ${dateStr}: +${count.toLocaleString()}`);
      }
    }

    const totalCounted = Object.values(dailyInserts[cat]).reduce((a, b) => a + b, 0);
    console.log(`  Total contado: ${totalCounted.toLocaleString()} | Real: ${currentTotals[cat].toLocaleString()}`);
    console.log(`  Diferenca: ${(currentTotals[cat] - totalCounted).toLocaleString()}\n`);
  }

  // 4. Construir totais acumulados
  console.log('4. Construindo totais acumulados...\n');
  const snapshots = []; // { data, categoria, total }

  for (const [cat, inserts] of Object.entries(dailyInserts)) {
    let cumulative = 0;
    let lastCumulative = -1;

    for (const dateStr of dates) {
      const dayCount = inserts[dateStr] || 0;
      cumulative += dayCount;

      // So registra se houve mudanca real (evita duplicatas)
      if (cumulative > 0 && cumulative !== lastCumulative) {
        snapshots.push({ data: dateStr, categoria: cat, total: cumulative });
        lastCumulative = cumulative;
      }
    }

    // Garantir que o ultimo dia tenha o total atual real
    const lastSnap = snapshots.filter(s => s.categoria === cat).pop();
    if (lastSnap && lastSnap.total !== currentTotals[cat]) {
      // Adicionar snapshot de hoje com total real
      snapshots.push({ data: today, categoria: cat, total: currentTotals[cat] });
      console.log(`  ${cat}: ajustado total final ${lastSnap.total.toLocaleString()} -> ${currentTotals[cat].toLocaleString()}`);
    } else if (!lastSnap && currentTotals[cat] > 0) {
      // Nenhum insert diario encontrado, mas tabela tem dados - snapshot so de hoje
      snapshots.push({ data: today, categoria: cat, total: currentTotals[cat] });
      console.log(`  ${cat}: sem inserts diarios detectados, criando snapshot apenas de hoje: ${currentTotals[cat].toLocaleString()}`);
    }
  }

  console.log(`\n  Total de snapshots a inserir: ${snapshots.length}\n`);

  // 5. Limpar stats_historico
  console.log('5. Limpando stats_historico...');
  const { error: deleteError } = await supabase
    .from('stats_historico')
    .delete()
    .gte('data', '1900-01-01'); // Delete tudo

  if (deleteError) {
    console.error('  ERRO ao limpar:', deleteError.message);
    process.exit(1);
  }

  // Verificar se limpou
  const { count: remaining } = await supabase
    .from('stats_historico')
    .select('id', { count: 'exact', head: true });
  console.log(`  Registros restantes: ${remaining || 0}\n`);

  // 6. Inserir snapshots reais
  console.log('6. Inserindo snapshots reais...\n');

  let inserted = 0;
  let errors = 0;
  for (const snap of snapshots) {
    const { error } = await supabase
      .from('stats_historico')
      .upsert(snap, { onConflict: 'data,categoria' });

    if (error) {
      console.error(`  ERRO ${snap.data}/${snap.categoria}: ${error.message}`);
      errors++;
    } else {
      inserted++;
    }
  }

  console.log(`  Inseridos: ${inserted} | Erros: ${errors}\n`);

  // 7. Verificacao final
  console.log('7. VERIFICACAO FINAL\n');

  const { data: allData } = await supabase
    .from('stats_historico')
    .select('*')
    .order('data', { ascending: true });

  console.log(`Total registros em stats_historico: ${(allData || []).length}\n`);

  console.log('DATA       | empresas    | pessoas     | politicos   | mandatos    | emendas     | noticias');
  console.log('-'.repeat(99));

  const byDate = {};
  for (const row of allData || []) {
    if (!byDate[row.data]) byDate[row.data] = {};
    byDate[row.data][row.categoria] = row.total;
  }

  for (const d of Object.keys(byDate).sort()) {
    const r = byDate[d];
    console.log(
      d + ' | ' +
      String(r.empresas ?? '-').padStart(11) + ' | ' +
      String(r.pessoas ?? '-').padStart(11) + ' | ' +
      String(r.politicos ?? '-').padStart(11) + ' | ' +
      String(r.mandatos ?? '-').padStart(11) + ' | ' +
      String(r.emendas ?? '-').padStart(11) + ' | ' +
      String(r.noticias ?? '-').padStart(11)
    );
  }

  // Comparar com totais reais
  console.log('\n--- COMPARACAO COM TOTAIS REAIS ---\n');
  const categories = ['empresas', 'pessoas', 'politicos', 'mandatos', 'emendas', 'noticias'];
  const lastDate = Object.keys(byDate).sort().pop();
  const lastSnaps = byDate[lastDate] || {};

  console.log('Categoria    | Ultimo Snap  | Real (estimated) | Diferenca');
  console.log('-'.repeat(65));
  for (const cat of categories) {
    const snap = lastSnaps[cat] || 0;
    const real = currentTotals[cat] || 0;
    const diff = real - snap;
    console.log(
      cat.padEnd(12) + ' | ' +
      String(snap).padStart(12) + ' | ' +
      String(real).padStart(16) + ' | ' +
      String(diff > 0 ? '+' + diff : diff).padStart(10)
    );
  }

  console.log('\n=== REBUILD COMPLETO ===');
  console.log('Dados na stats_historico agora refletem APENAS imports REAIS.');
  console.log('O endpoint /stats/history preenche lacunas automaticamente (carry forward).');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
