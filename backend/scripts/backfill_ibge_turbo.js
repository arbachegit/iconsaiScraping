/**
 * Backfill TURBO: preencher 100% dos codigo_ibge em dim_empresas
 *
 * Estrategia de velocidade maxima:
 *   FASE 1: Usar CEP cache existente (117K+) -> UPDATE por CEP (sem API calls)
 *   FASE 2: Amostrar empresas sem ibge -> descobrir novos CEPs -> BrasilAPI -> UPDATE por CEP
 *   FASE 3: Fallback - tentar CEPs formatados com hifen
 *
 * Otimizacao chave: UPDATE POR CEP (1 query atualiza N empresas com mesmo CEP)
 *
 * PREREQUISITO (opcional, acelera ~10x):
 *   Execute no SQL Editor do Supabase:
 *   CREATE INDEX CONCURRENTLY idx_dim_empresas_cep_ibge ON dim_empresas(cep) WHERE codigo_ibge IS NULL;
 *
 * Usage:
 *   cd backend && node scripts/backfill_ibge_turbo.js
 *   cd backend && node scripts/backfill_ibge_turbo.js --dry-run
 *   cd backend && node scripts/backfill_ibge_turbo.js --fase=1
 *   cd backend && node scripts/backfill_ibge_turbo.js --fase=2
 *   cd backend && node scripts/backfill_ibge_turbo.js --fase=1,2,3
 *   cd backend && node scripts/backfill_ibge_turbo.js --concurrency=200
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

// ============================================================
// CONFIG
// ============================================================

const DRY_RUN = process.argv.includes('--dry-run');
const FASE_ARG = process.argv.find(a => a.startsWith('--fase='));
const FASES = FASE_ARG ? FASE_ARG.split('=')[1].split(',').map(Number) : [1, 2, 3];

const CONC_ARG = process.argv.find(a => a.startsWith('--concurrency='));
const UPDATE_CONCURRENT = CONC_ARG ? parseInt(CONC_ARG.split('=')[1], 10) : 100;
const API_CONCURRENT = 50;
const SAMPLE_SIZE = 5000; // Records per sample in FASE 2

const CEP_CACHE_FILE = join(__dirname, '.cep_cache.json');

// ============================================================
// CLIENTS
// ============================================================

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const brasilDataHub = createClient(
  process.env.BRASIL_DATA_HUB_URL,
  process.env.BRASIL_DATA_HUB_KEY,
  { db: { schema: 'staging' } }
);

// ============================================================
// CACHES
// ============================================================

let cepCache = {};
const municipioByNome = new Map();
const cepToIbge = new Map();
const processedCeps = new Set(); // CEPs already tried (in cache or API-checked)

function loadCache(file) {
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* ignore */ }
  }
  return {};
}

function saveCache(file, data) {
  writeFileSync(file, JSON.stringify(data), 'utf8');
}

// ============================================================
// TIMER
// ============================================================

const startTime = Date.now();

function elapsed() {
  const ms = Date.now() - startTime;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m${s % 60}s`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

function eta(done, total) {
  if (done === 0) return '...';
  const msPerItem = (Date.now() - startTime) / done;
  const remaining = (total - done) * msPerItem;
  const s = Math.floor(remaining / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `~${h}h${m % 60}m`;
  if (m > 0) return `~${m}m${s % 60}s`;
  return `~${s}s`;
}

// ============================================================
// GEO: Pre-load municipios
// ============================================================

async function preloadMunicipios() {
  console.log('[GEO] Carregando estados...');
  const { data: estados } = await brasilDataHub.from('geo_estados').select('id, codigo_ibge_uf, sigla');
  const estadoById = new Map();
  for (const est of estados || []) estadoById.set(est.id, est);

  console.log('[GEO] Carregando municipios...');
  let all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await brasilDataHub
      .from('geo_municipios')
      .select('codigo_ibge, nome, estado_id, latitude, longitude')
      .range(offset, offset + 999);
    if (error || !data || data.length === 0) break;
    all = all.concat(data);
    offset += 1000;
    if (data.length < 1000) break;
  }

  for (const mun of all) {
    const estado = estadoById.get(mun.estado_id);
    if (!estado) continue;
    municipioByNome.set(`${mun.nome.toLowerCase()}|${estado.sigla}`, {
      codigo_ibge: String(mun.codigo_ibge),
      codigo_ibge_uf: estado.codigo_ibge_uf,
      sigla: estado.sigla,
      nome: mun.nome,
      latitude: mun.latitude,
      longitude: mun.longitude
    });
  }

  console.log(`[GEO] ${all.length} municipios | ${estadoById.size} estados`);
  return all.length;
}

// ============================================================
// CEP -> IBGE resolution
// ============================================================

function resolveCep(cep) {
  if (cepToIbge.has(cep)) return cepToIbge.get(cep);

  const data = cepCache[cep];
  if (!data || !data.city || !data.state) return null;

  const key = `${data.city.toLowerCase()}|${data.state}`;
  const geo = municipioByNome.get(key);
  if (!geo) return null;

  const ibgeData = {
    codigo_ibge: geo.codigo_ibge,
    codigo_ibge_uf: geo.codigo_ibge_uf,
    cidade: geo.nome,
    estado: geo.sigla,
    latitude: geo.latitude,
    longitude: geo.longitude
  };
  cepToIbge.set(cep, ibgeData);
  return ibgeData;
}

function buildCepIbgeMap() {
  let mapped = 0;
  let unmapped = 0;

  for (const [cep, data] of Object.entries(cepCache)) {
    processedCeps.add(cep);
    if (resolveCep(cep)) mapped++;
    else unmapped++;
  }

  console.log(`[MAP] CEP->IBGE: ${mapped} mapeados | ${unmapped} sem match`);
  return mapped;
}

// ============================================================
// UPDATE: batch by CEP
// ============================================================

async function updateByCep(cep, ibgeData, retries = 2) {
  if (DRY_RUN) return { updated: 1, error: null };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { error } = await supabase
      .from('dim_empresas')
      .update({
        codigo_ibge: ibgeData.codigo_ibge,
        codigo_ibge_uf: ibgeData.codigo_ibge_uf,
        cidade: ibgeData.cidade,
        estado: ibgeData.estado,
        latitude: ibgeData.latitude,
        longitude: ibgeData.longitude
      })
      .eq('cep', cep)
      .is('codigo_ibge', null);

    if (!error) return { updated: 1, error: null };
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    } else {
      return { updated: 0, error };
    }
  }
  return { updated: 0, error: { message: 'max retries' } };
}

async function batchUpdateCeps(entries) {
  const stats = { ceps: 0, empresas: 0, erros: 0 };

  for (let i = 0; i < entries.length; i += UPDATE_CONCURRENT) {
    const chunk = entries.slice(i, i + UPDATE_CONCURRENT);
    const results = await Promise.all(
      chunk.map(([cep, ibge]) => updateByCep(cep, ibge))
    );
    for (const res of results) {
      if (res.error) stats.erros++;
      else { stats.ceps++; stats.empresas += res.updated; }
    }
  }

  return stats;
}

// ============================================================
// BrasilAPI: fetch CEP data
// ============================================================

async function fetchCep(cep) {
  const clean = cep.replace(/[^\d]/g, '');
  if (clean.length !== 8) return null;
  if (cepCache[clean] !== undefined) return cepCache[clean];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`https://brasilapi.com.br/api/cep/v1/${clean}`, {
        headers: { 'User-Agent': 'IconsAI-Backfill/3.0' },
        signal: AbortSignal.timeout(10000)
      });
      if (resp.status === 404) { cepCache[clean] = null; return null; }
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 3000));
        continue;
      }
      if (!resp.ok) { cepCache[clean] = null; return null; }

      const data = await resp.json();
      const result = { city: data.city, state: data.state };
      cepCache[clean] = result;
      return result;
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  cepCache[clean] = null;
  return null;
}

async function resolveCepsBatch(ceps) {
  const queue = [...ceps];
  const workers = Array.from({ length: Math.min(API_CONCURRENT, queue.length) }, async () => {
    while (queue.length > 0) {
      const cep = queue.pop();
      if (!cep) break;
      await fetchCep(cep);
    }
  });
  await Promise.all(workers);
}

// ============================================================
// FASE 1: Use existing cache
// ============================================================

async function fase1Cache() {
  console.log('\n' + '='.repeat(60));
  console.log('  FASE 1: CEP CACHE -> UPDATE POR CEP (sem API)');
  console.log('='.repeat(60));

  const entries = Array.from(cepToIbge.entries());
  const total = entries.length;
  console.log(`[FASE1] ${total} CEPs mapeados a processar (${UPDATE_CONCURRENT} concurrent)`);

  const stats = { ceps: 0, empresas: 0, erros: 0 };
  const phaseStart = Date.now();

  for (let i = 0; i < total; i += UPDATE_CONCURRENT) {
    const chunk = entries.slice(i, i + UPDATE_CONCURRENT);
    const results = await Promise.all(
      chunk.map(([cep, ibge]) => updateByCep(cep, ibge))
    );

    for (const res of results) {
      if (res.error) stats.erros++;
      else { stats.ceps++; stats.empresas += res.updated; }
    }

    const done = Math.min(i + UPDATE_CONCURRENT, total);
    if (done % 1000 < UPDATE_CONCURRENT || done >= total) {
      const pct = ((done / total) * 100).toFixed(1);
      const rate = Math.round(done / ((Date.now() - phaseStart) / 1000));
      console.log(`  [${elapsed()}] ${done.toLocaleString()}/${total.toLocaleString()} CEPs (${pct}%) | ${stats.empresas.toLocaleString()} empresas | ${rate} CEPs/s | ETA: ${eta(done, total)}`);
    }
  }

  console.log(`[FASE1] ${stats.ceps.toLocaleString()} CEPs -> ${stats.empresas.toLocaleString()} empresas | ${stats.erros} erros`);
  return stats;
}

// ============================================================
// FASE 2: Sample-Resolve-Update loop
// ============================================================

async function fase2Api() {
  console.log('\n' + '='.repeat(60));
  console.log('  FASE 2: DESCOBRIR NOVOS CEPs (sample -> API -> update)');
  console.log('='.repeat(60));

  const stats = { rounds: 0, apiCalls: 0, cepsResolved: 0, empresas: 0, erros: 0 };

  let stuckCount = 0;

  while (true) {
    // Note: estimated count is unreliable on large tables during updates
    // Progress is tracked by how many NEW CEPs we discover per round

    stats.rounds++;
    console.log(`\n  [ROUND ${stats.rounds}]`);

    // Sample companies without ibge using cursor-based pagination (UUID ids)
    const newCeps = new Set();
    let lastId = null;
    let sampled = 0;

    while (sampled < SAMPLE_SIZE * 5) {
      let query = supabase
        .from('dim_empresas')
        .select('id, cep')
        .is('codigo_ibge', null)
        .not('cep', 'is', null)
        .neq('cep', '')
        .order('id')
        .limit(1000);

      if (lastId) query = query.gt('id', lastId);

      const { data, error } = await query;
      if (error) { console.error('  Erro sample:', error.message); break; }
      if (!data || data.length === 0) break;

      for (const e of data) {
        const clean = (e.cep || '').replace(/[^\d]/g, '');
        if (clean.length === 8 && !processedCeps.has(clean)) {
          newCeps.add(clean);
        }
        lastId = e.id;
      }

      sampled += data.length;

      // Stop when we have enough new CEPs to process
      if (newCeps.size >= SAMPLE_SIZE) break;
      if (data.length < 1000) break;
    }

    if (newCeps.size === 0) {
      console.log('  Nenhum CEP novo encontrado neste round.');
      stuckCount++;
      if (stuckCount >= 5) {
        console.log(`[FASE2] Sem CEPs novos por 5 rounds. Todos os CEPs acessiveis ja foram processados.`);
        break;
      }
      continue;
    } else {
      stuckCount = 0;
    }

    console.log(`  ${newCeps.size} CEPs novos encontrados (sampled ${sampled.toLocaleString()} rows)`);

    // Resolve via BrasilAPI
    const cepsToResolve = Array.from(newCeps);
    stats.apiCalls += cepsToResolve.length;
    console.log(`  Resolvendo ${cepsToResolve.length} CEPs via BrasilAPI (${API_CONCURRENT} concurrent)...`);

    await resolveCepsBatch(cepsToResolve);

    // Mark as processed
    for (const cep of cepsToResolve) processedCeps.add(cep);

    // Build mappings
    const newMappings = [];
    for (const cep of cepsToResolve) {
      const ibge = resolveCep(cep);
      if (ibge) newMappings.push([cep, ibge]);
    }

    console.log(`  ${newMappings.length}/${cepsToResolve.length} resolvidos com sucesso`);

    // Batch update
    if (newMappings.length > 0) {
      console.log(`  Atualizando ${newMappings.length} CEPs...`);
      const updateStats = await batchUpdateCeps(newMappings);
      stats.cepsResolved += updateStats.ceps;
      stats.empresas += updateStats.empresas;
      stats.erros += updateStats.erros;
      console.log(`  -> ${updateStats.empresas.toLocaleString()} empresas atualizadas neste round`);
    }

    // Save cache
    saveCache(CEP_CACHE_FILE, cepCache);
    console.log(`  [${elapsed()}] Total: ${stats.empresas.toLocaleString()} empresas | ${stats.apiCalls} API calls | Cache: ${Object.keys(cepCache).length}`);
  }

  saveCache(CEP_CACHE_FILE, cepCache);
  console.log(`[FASE2] ${stats.cepsResolved} CEPs -> ${stats.empresas.toLocaleString()} empresas | ${stats.apiCalls} API calls | ${stats.rounds} rounds`);
  return stats;
}

// ============================================================
// FASE 3: Formatted CEPs (with dash)
// ============================================================

async function fase3Fallback() {
  console.log('\n' + '='.repeat(60));
  console.log('  FASE 3: CEPs FORMATADOS (com hifen)');
  console.log('='.repeat(60));

  const entries = Array.from(cepToIbge.entries());
  console.log(`[FASE3] Tentando ${entries.length} CEPs com formato XXXXX-XXX...`);

  const formatted = entries
    .filter(([cep]) => cep.length === 8)
    .map(([cep, ibge]) => [`${cep.slice(0, 5)}-${cep.slice(5)}`, ibge]);

  if (formatted.length === 0) {
    console.log('[FASE3] Nenhum CEP para formatar.');
    return { ceps: 0, empresas: 0, erros: 0 };
  }

  const stats = await batchUpdateCeps(formatted);
  console.log(`[FASE3] ${stats.empresas.toLocaleString()} empresas adicionais atualizadas`);
  return stats;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log('  BACKFILL IBGE TURBO - dim_empresas');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'PRODUCAO'}`);
  console.log(`  Fases: ${FASES.join(', ')}`);
  console.log(`  Concurrency: ${UPDATE_CONCURRENT} updates | ${API_CONCURRENT} API`);
  console.log('='.repeat(60));

  // Load caches
  cepCache = loadCache(CEP_CACHE_FILE);
  console.log(`[CACHE] ${Object.keys(cepCache).length} CEPs em cache`);

  // Pre-load geo data
  const totalMunicipios = await preloadMunicipios();
  if (totalMunicipios === 0) {
    console.error('[ERRO] Nenhum municipio. Verifique BRASIL_DATA_HUB_URL/KEY.');
    process.exit(1);
  }

  // Build mapping from cache
  buildCepIbgeMap();

  // Current state (estimated - exact times out on 64M+ rows)
  const { count: totalEmpresas } = await supabase
    .from('dim_empresas')
    .select('id', { count: 'estimated', head: true });
  const { count: semIbge } = await supabase
    .from('dim_empresas')
    .select('id', { count: 'estimated', head: true })
    .is('codigo_ibge', null);

  const comIbge = (totalEmpresas || 0) - (semIbge || 0);
  const pctAtual = ((comIbge / (totalEmpresas || 1)) * 100).toFixed(1);
  console.log(`\n[STATUS] ${comIbge.toLocaleString()}/${(totalEmpresas || 0).toLocaleString()} com ibge (${pctAtual}%) | ${(semIbge || 0).toLocaleString()} faltando`);

  console.log('\n  TIP: Para acelerar 10x, crie o index no SQL Editor do Supabase:');
  console.log('  CREATE INDEX CONCURRENTLY idx_dim_empresas_cep_ibge');
  console.log('    ON dim_empresas(cep) WHERE codigo_ibge IS NULL;\n');

  const resultados = {};

  if (FASES.includes(1)) resultados.fase1 = await fase1Cache();
  if (FASES.includes(2)) resultados.fase2 = await fase2Api();
  if (FASES.includes(3)) resultados.fase3 = await fase3Fallback();

  // Final count
  const { count: semIbgeFinal } = await supabase
    .from('dim_empresas')
    .select('id', { count: 'estimated', head: true })
    .is('codigo_ibge', null);

  const comIbgeFinal = (totalEmpresas || 0) - (semIbgeFinal || 0);
  const pctFinal = ((comIbgeFinal / (totalEmpresas || 1)) * 100).toFixed(1);

  // Report
  console.log('\n' + '='.repeat(60));
  console.log('  RELATORIO FINAL');
  console.log('='.repeat(60));
  console.log(`  Tempo total: ${elapsed()}`);
  console.log();

  if (resultados.fase1) {
    console.log(`  FASE 1 (Cache):    ${resultados.fase1.ceps.toLocaleString()} CEPs -> ${resultados.fase1.empresas.toLocaleString()} empresas`);
  }
  if (resultados.fase2) {
    console.log(`  FASE 2 (API):      ${resultados.fase2.cepsResolved.toLocaleString()} CEPs -> ${resultados.fase2.empresas.toLocaleString()} empresas (${resultados.fase2.apiCalls} API calls)`);
  }
  if (resultados.fase3) {
    console.log(`  FASE 3 (Fallback): ${resultados.fase3.empresas.toLocaleString()} empresas adicionais`);
  }

  const totalAtualizado = (resultados.fase1?.empresas || 0) + (resultados.fase2?.empresas || 0) + (resultados.fase3?.empresas || 0);
  console.log();
  console.log(`  ANTES:  ${comIbge.toLocaleString()} / ${(totalEmpresas || 0).toLocaleString()} (${pctAtual}%)`);
  console.log(`  DEPOIS: ${comIbgeFinal.toLocaleString()} / ${(totalEmpresas || 0).toLocaleString()} (${pctFinal}%)`);
  console.log(`  DELTA:  +${totalAtualizado.toLocaleString()} empresas`);

  if (semIbgeFinal && semIbgeFinal > 0) {
    console.log(`\n  [NOTA] ${semIbgeFinal.toLocaleString()} ainda sem ibge (CEP invalido/inexistente/sem match)`);
  }

  if (DRY_RUN) console.log('\n  [DRY RUN] Nenhuma alteracao salva.');

  console.log('='.repeat(60));
  saveCache(CEP_CACHE_FILE, cepCache);
}

main().catch(err => {
  saveCache(CEP_CACHE_FILE, cepCache);
  console.error('[FATAL]', err);
  process.exit(1);
});
