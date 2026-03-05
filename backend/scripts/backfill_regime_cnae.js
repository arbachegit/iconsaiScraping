/**
 * Backfill regime tributario + CNAE from raw_cnpj_data
 *
 * Preenche em 2 fases:
 *   FASE 1: fato_regime_tributario (raw_cnpj_data → regime + CNAE)
 *           Para empresas que TEM raw_cnpj_data mas NAO possuem registro em fato_regime_tributario
 *   FASE 2: dim_empresas.cnae_id (raw_cnpj_data.cnae_fiscal → raw_cnae.codigo_numerico)
 *           Para empresas com cnae_id NULL
 *
 * Features:
 *   - Dry-run mode
 *   - Batch processing com paginacao
 *   - Relatorio detalhado
 *
 * Usage:
 *   cd backend && node scripts/backfill_regime_cnae.js
 *   cd backend && node scripts/backfill_regime_cnae.js --dry-run
 *   cd backend && node scripts/backfill_regime_cnae.js --fase=1
 *   cd backend && node scripts/backfill_regime_cnae.js --fase=2
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

// ============================================================
// CONFIG
// ============================================================

const DRY_RUN = process.argv.includes('--dry-run');
const FASE_ARG = process.argv.find(a => a.startsWith('--fase='));
const FASES_ATIVAS = FASE_ARG
  ? FASE_ARG.split('=')[1].split(',').map(Number)
  : [1, 2];

const PAGE_SIZE = 500;
const BATCH_SIZE = 20; // concurrent Supabase writes

// ============================================================
// CLIENT
// ============================================================

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ============================================================
// CNAE LOOKUP
// ============================================================

const cnaeByNumerico = new Map(); // "6201500" → { id, descricao, secao }

async function preloadCnae() {
  console.log('[CNAE] Carregando tabela raw_cnae...');
  let all = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('raw_cnae')
      .select('id, codigo_numerico, descricao, secao')
      .range(offset, offset + 999);

    if (error) { console.error('[CNAE] Erro:', error.message); break; }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    offset += 1000;
    if (data.length < 1000) break;
  }

  for (const cnae of all) {
    if (cnae.codigo_numerico) {
      cnaeByNumerico.set(cnae.codigo_numerico, {
        id: cnae.id,
        descricao: cnae.descricao,
        secao: cnae.secao
      });
    }
  }

  console.log(`[CNAE] ${cnaeByNumerico.size} registros carregados`);
  return cnaeByNumerico.size;
}

/**
 * Normalize CNAE code to 7-digit numeric string
 * Handles: 6201500 (number), "6201500", "6201-5/00"
 */
function normalizeCnae(cnae) {
  if (cnae == null) return null;
  const str = String(cnae).replace(/[-\/\.]/g, '');
  if (str.length === 0) return null;
  return str.padStart(7, '0');
}

/**
 * Determine regime tributario from BrasilAPI fields
 */
function determineRegime(raw) {
  if (raw.opcao_pelo_mei === true) return 'MEI';
  if (raw.opcao_pelo_simples === true) return 'SIMPLES_NACIONAL';
  // Fallback: cannot determine with certainty
  return 'LUCRO_PRESUMIDO';
}

// ============================================================
// FASE 1: INSERT fato_regime_tributario
// ============================================================

async function fase1RegimeTributario() {
  console.log('\n' + '='.repeat(60));
  console.log('  FASE 1: REGIME TRIBUTARIO (raw_cnpj_data → fato_regime_tributario)');
  console.log('='.repeat(60));

  const stats = { total: 0, inseridos: 0, sem_brasilapi: 0, ja_existe: 0, sem_cnae: 0, erros: 0 };

  // Step 1: Get all empresa_ids that already have fato_regime_tributario
  console.log('[FASE1] Carregando empresa_ids com regime existente...');
  const existingIds = new Set();
  let regOffset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('fato_regime_tributario')
      .select('empresa_id')
      .range(regOffset, regOffset + 999);

    if (error) { console.error('[FASE1] Erro ao carregar regimes:', error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data) existingIds.add(r.empresa_id);
    regOffset += 1000;
    if (data.length < 1000) break;
  }

  console.log(`[FASE1] ${existingIds.size} empresas ja possuem regime`);

  // Step 2: Paginate dim_empresas with raw_cnpj_data NOT NULL
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: empresas, error } = await supabase
      .from('dim_empresas')
      .select('id, cnpj, raw_cnpj_data')
      .not('raw_cnpj_data', 'is', null)
      .range(offset, offset + PAGE_SIZE - 1)
      .order('id');

    if (error) { console.error('[FASE1] Erro ao buscar empresas:', error.message); break; }
    if (!empresas || empresas.length === 0) { hasMore = false; break; }

    console.log(`[FASE1] Lote ${Math.floor(offset / PAGE_SIZE) + 1}: ${empresas.length} empresas`);

    // Filter out those that already have regime
    const toProcess = empresas.filter(e => !existingIds.has(e.id));
    stats.total += empresas.length;
    stats.ja_existe += empresas.length - toProcess.length;

    if (toProcess.length === 0) {
      console.log(`  [SKIP] Todas ja possuem regime`);
      if (empresas.length < PAGE_SIZE) hasMore = false;
      offset += PAGE_SIZE;
      continue;
    }

    // Build insert records
    const records = [];
    for (const empresa of toProcess) {
      const raw = empresa.raw_cnpj_data;
      if (!raw || typeof raw !== 'object') {
        stats.sem_brasilapi++;
        continue;
      }

      const cnaeCode = normalizeCnae(raw.cnae_fiscal);
      const cnaeMatch = cnaeCode ? cnaeByNumerico.get(cnaeCode) : null;

      if (!cnaeCode) {
        stats.sem_cnae++;
      }

      const regime = determineRegime(raw);

      records.push({
        empresa_id: empresa.id,
        porte: raw.porte || null,
        natureza_juridica: raw.natureza_juridica || null,
        capital_social: raw.capital_social || null,
        cnae_principal: cnaeCode || (raw.cnae_fiscal ? String(raw.cnae_fiscal) : null),
        cnae_descricao: raw.cnae_fiscal_descricao || cnaeMatch?.descricao || null,
        cnae_id: cnaeMatch?.id || null,
        regime_tributario: regime,
        simples_optante: raw.opcao_pelo_simples ?? null,
        simples_desde: raw.data_opcao_pelo_simples || null,
        mei_optante: raw.opcao_pelo_mei ?? null,
        mei_desde: raw.data_opcao_pelo_mei || null,
        data_inicio: raw.data_opcao_pelo_simples || raw.data_opcao_pelo_mei || null,
        ativo: true,
        raw_cnpja: {}
      });
    }

    if (records.length === 0) {
      if (empresas.length < PAGE_SIZE) hasMore = false;
      offset += PAGE_SIZE;
      continue;
    }

    // Batch insert
    if (!DRY_RUN) {
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const chunk = records.slice(i, i + BATCH_SIZE);
        const { error: insertError } = await supabase
          .from('fato_regime_tributario')
          .insert(chunk);

        if (insertError) {
          console.error(`  [ERRO] Batch insert falhou:`, insertError.message);
          stats.erros += chunk.length;
        } else {
          stats.inseridos += chunk.length;
        }
      }
    } else {
      stats.inseridos += records.length;
      for (const rec of records.slice(0, 3)) {
        console.log(`  [DRY] empresa:${rec.empresa_id} → ${rec.regime_tributario} | cnae:${rec.cnae_principal} | ${rec.cnae_descricao?.substring(0, 40) || 'N/A'}`);
      }
      if (records.length > 3) console.log(`  [DRY] ... +${records.length - 3}`);
    }

    if (empresas.length < PAGE_SIZE) hasMore = false;
    offset += PAGE_SIZE;
  }

  console.log(`[FASE1] Resultado: ${stats.inseridos} inseridos | ${stats.ja_existe} ja existiam | ${stats.sem_cnae} sem CNAE | ${stats.erros} erros`);
  return stats;
}

// ============================================================
// FASE 2: UPDATE dim_empresas.cnae_id
// ============================================================

async function fase2CnaeId() {
  console.log('\n' + '='.repeat(60));
  console.log('  FASE 2: CNAE_ID (raw_cnpj_data.cnae_fiscal → dim_empresas.cnae_id)');
  console.log('='.repeat(60));

  const stats = { total: 0, atualizadas: 0, sem_brasilapi: 0, sem_match: 0, erros: 0 };

  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: empresas, error } = await supabase
      .from('dim_empresas')
      .select('id, cnpj, raw_cnpj_data')
      .is('cnae_id', null)
      .not('raw_cnpj_data', 'is', null)
      .range(offset, offset + PAGE_SIZE - 1)
      .order('id');

    if (error) { console.error('[FASE2] Erro:', error.message); break; }
    if (!empresas || empresas.length === 0) { hasMore = false; break; }

    stats.total += empresas.length;
    console.log(`[FASE2] Lote ${Math.floor(offset / PAGE_SIZE) + 1}: ${empresas.length} empresas`);

    const updates = [];
    for (const empresa of empresas) {
      const raw = empresa.raw_cnpj_data;
      if (!raw || typeof raw !== 'object') {
        stats.sem_brasilapi++;
        continue;
      }

      const cnaeCode = normalizeCnae(raw.cnae_fiscal);
      if (!cnaeCode) {
        stats.sem_match++;
        continue;
      }

      const cnaeMatch = cnaeByNumerico.get(cnaeCode);
      if (!cnaeMatch) {
        // Fallback: try matching by first 5 digits (classe level)
        const classe = cnaeCode.substring(0, 5);
        let fallbackMatch = null;
        for (const [key, val] of cnaeByNumerico) {
          if (key.startsWith(classe)) {
            fallbackMatch = val;
            break;
          }
        }

        if (!fallbackMatch) {
          stats.sem_match++;
          continue;
        }

        updates.push({ id: empresa.id, cnae_id: fallbackMatch.id });
      } else {
        updates.push({ id: empresa.id, cnae_id: cnaeMatch.id });
      }
    }

    // Batch update
    if (updates.length > 0 && !DRY_RUN) {
      for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const chunk = updates.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          chunk.map(item =>
            supabase.from('dim_empresas').update({ cnae_id: item.cnae_id }).eq('id', item.id)
          )
        );
        for (const res of results) {
          if (res.error) stats.erros++;
          else stats.atualizadas++;
        }
      }
    } else {
      stats.atualizadas += updates.length;
      if (DRY_RUN && updates.length > 0) {
        for (const item of updates.slice(0, 3)) {
          console.log(`  [DRY] id:${item.id} → cnae_id:${item.cnae_id}`);
        }
        if (updates.length > 3) console.log(`  [DRY] ... +${updates.length - 3}`);
      }
    }

    if (empresas.length < PAGE_SIZE) hasMore = false;
    offset += PAGE_SIZE;
  }

  console.log(`[FASE2] Resultado: ${stats.atualizadas}/${stats.total} atualizadas | ${stats.sem_match} sem match | ${stats.erros} erros`);
  return stats;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log('  BACKFILL REGIME TRIBUTARIO + CNAE');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'PRODUCAO'}`);
  console.log(`  Fases: ${FASES_ATIVAS.join(', ')}`);
  console.log('='.repeat(60));

  // Pre-load CNAE lookup
  const cnaeCount = await preloadCnae();
  if (cnaeCount === 0) {
    console.error('[ERRO] Tabela raw_cnae vazia. Execute migration 012 primeiro.');
    process.exit(1);
  }

  const resultados = {};

  if (FASES_ATIVAS.includes(1)) {
    resultados.fase1 = await fase1RegimeTributario();
  }

  if (FASES_ATIVAS.includes(2)) {
    resultados.fase2 = await fase2CnaeId();
  }

  // Relatorio final
  console.log('\n' + '='.repeat(60));
  console.log('  RELATORIO FINAL');
  console.log('='.repeat(60));

  if (resultados.fase1) {
    console.log(`  FASE 1 (Regime):   ${resultados.fase1.inseridos} inseridos | ${resultados.fase1.ja_existe} ja existiam | ${resultados.fase1.erros} erros`);
  }
  if (resultados.fase2) {
    console.log(`  FASE 2 (CNAE ID):  ${resultados.fase2.atualizadas} atualizadas | ${resultados.fase2.sem_match} sem match | ${resultados.fase2.erros} erros`);
  }

  if (DRY_RUN) {
    console.log('\n  [DRY RUN] Nenhuma alteracao salva. Rode sem --dry-run para aplicar.');
  }

  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
