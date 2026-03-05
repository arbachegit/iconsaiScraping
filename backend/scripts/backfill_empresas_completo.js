/**
 * Backfill completo de dim_empresas
 *
 * Preenche em 3 fases:
 *   FASE 1: Geo (CEP → BrasilAPI → geo_municipios) → codigo_ibge, codigo_ibge_uf, latitude, longitude
 *   FASE 2: Cidade/Estado (codigo_ibge → geo_municipios) → cidade, estado
 *   FASE 3: Website (CNPJ + razao_social → Perplexity) → website
 *
 * Features:
 *   - Cache persistente em disco (resume se interromper)
 *   - Concurrency limitada (20 geo, 3 Perplexity)
 *   - Rate limiting com exponential backoff
 *   - Dry-run mode
 *   - Relatorio detalhado
 *
 * Usage:
 *   cd backend && node scripts/backfill_empresas_completo.js
 *   cd backend && node scripts/backfill_empresas_completo.js --dry-run
 *   cd backend && node scripts/backfill_empresas_completo.js --fase=3          # Só website
 *   cd backend && node scripts/backfill_empresas_completo.js --fase=1,2        # Só geo + cidade
 *   cd backend && node scripts/backfill_empresas_completo.js --limit=50        # Limitar registros (website)
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
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const WEBSITE_LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : 0; // 0 = sem limite

const FASE_ARG = process.argv.find(a => a.startsWith('--fase='));
const FASES_ATIVAS = FASE_ARG
  ? FASE_ARG.split('=')[1].split(',').map(Number)
  : [1, 2, 3]; // todas por padrão

// Worker mode: --worker=N/M (worker N de M total) para split de fase 3
const WORKER_ARG = process.argv.find(a => a.startsWith('--worker='));
const WORKER_ID = WORKER_ARG ? parseInt(WORKER_ARG.split('=')[1].split('/')[0], 10) : 0;
const WORKER_TOTAL = WORKER_ARG ? parseInt(WORKER_ARG.split('=')[1].split('/')[1], 10) : 1;

const PAGE_SIZE = 1000;
const GEO_CONCURRENT = 20;
const PERPLEXITY_CONCURRENT = 2; // Respeitar rate limit
const PERPLEXITY_DELAY_MS = 1500; // Delay entre requests

const CEP_CACHE_FILE = join(__dirname, '.cep_cache.json');
const WEBSITE_CACHE_FILE = WORKER_ARG
  ? join(__dirname, `.website_cache_w${WORKER_ID}.json`)
  : join(__dirname, '.website_cache.json');

// ============================================================
// CLIENTS
// ============================================================

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const brasilDataHub = createClient(
  process.env.BRASIL_DATA_HUB_URL,
  process.env.BRASIL_DATA_HUB_KEY,
  { db: { schema: 'staging' } }
);

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

// ============================================================
// CACHES
// ============================================================

let cepCache = {};
let websiteCache = {};
const municipioByNomeCache = new Map(); // "nome_lower|SIGLA" → geo data
const municipioByIbgeCache = new Map(); // "codigo_ibge" → { nome, uf }

function loadCache(file) {
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch { /* ignore */ }
  }
  return {};
}

function saveCache(file, data) {
  writeFileSync(file, JSON.stringify(data), 'utf8');
}

// ============================================================
// FASE 1: GEO DATA (CEP → BrasilAPI → geo_municipios)
// ============================================================

async function preloadMunicipios() {
  console.log('[GEO] Carregando estados...');
  const { data: estados } = await brasilDataHub.from('geo_estados').select('id, codigo_ibge_uf, sigla');
  const estadoById = new Map();
  for (const est of estados || []) {
    estadoById.set(est.id, est);
  }

  console.log('[GEO] Carregando municipios...');
  let allMunicipios = [];
  let offset = 0;

  while (true) {
    const { data, error } = await brasilDataHub
      .from('geo_municipios')
      .select('codigo_ibge, nome, estado_id, latitude, longitude')
      .range(offset, offset + 999);

    if (error || !data || data.length === 0) break;
    allMunicipios = allMunicipios.concat(data);
    offset += 1000;
    if (data.length < 1000) break;
  }

  for (const mun of allMunicipios) {
    const estado = estadoById.get(mun.estado_id);
    if (!estado) continue;

    const entry = {
      codigo_ibge: mun.codigo_ibge,
      sigla: estado.sigla,
      codigo_ibge_uf: estado.codigo_ibge_uf,
      nome: mun.nome,
      latitude: mun.latitude,
      longitude: mun.longitude
    };

    municipioByNomeCache.set(`${mun.nome.toLowerCase()}|${estado.sigla}`, entry);
    municipioByIbgeCache.set(String(mun.codigo_ibge), entry);
  }

  console.log(`[GEO] ${allMunicipios.length} municipios | ${estadoById.size} estados`);
  return allMunicipios.length;
}

async function fetchCep(cep) {
  const clean = cep.replace(/[^\d]/g, '');
  if (clean.length !== 8) return null;
  if (cepCache[clean] !== undefined) return cepCache[clean];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`https://brasilapi.com.br/api/cep/v1/${clean}`, {
        headers: { 'User-Agent': 'IconsAI-Backfill/2.0' },
        signal: AbortSignal.timeout(10000)
      });

      if (resp.status === 404) { cepCache[clean] = null; return null; }
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
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

async function fetchCepsBatch(ceps) {
  const results = new Map();
  const queue = [...ceps];

  const workers = Array.from({ length: Math.min(GEO_CONCURRENT, queue.length) }, async () => {
    while (queue.length > 0) {
      const cep = queue.pop();
      if (!cep) break;
      const result = await fetchCep(cep);
      results.set(cep.replace(/[^\d]/g, ''), result);
    }
  });

  await Promise.all(workers);
  return results;
}

async function fase1Geo() {
  console.log('\n' + '='.repeat(60));
  console.log('  FASE 1: GEO DATA (CEP → codigo_ibge, lat, lng)');
  console.log('='.repeat(60));

  const stats = { total: 0, atualizadas: 0, sem_cep: 0, cep_nao_encontrado: 0, municipio_nao_match: 0, erros: 0 };

  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: empresas, error } = await supabase
      .from('dim_empresas')
      .select('id, cnpj, cep')
      .is('codigo_ibge', null)
      .not('cep', 'is', null)
      .neq('cep', '')
      .range(offset, offset + PAGE_SIZE - 1)
      .order('id');

    if (error) { console.error('[FASE1] Erro:', error.message); break; }
    if (!empresas || empresas.length === 0) { hasMore = false; break; }

    stats.total += empresas.length;
    console.log(`[FASE1] Lote ${Math.floor(offset / PAGE_SIZE) + 1}: ${empresas.length} empresas`);

    // Coletar CEPs unicos
    const cepsToFetch = new Set();
    for (const e of empresas) {
      const clean = e.cep.replace(/[^\d]/g, '');
      if (clean.length === 8 && cepCache[clean] === undefined) {
        cepsToFetch.add(clean);
      }
    }

    if (cepsToFetch.size > 0) {
      console.log(`  [API] Buscando ${cepsToFetch.size} CEPs na BrasilAPI...`);
      await fetchCepsBatch([...cepsToFetch]);
    }

    // Gerar updates
    const updates = [];
    for (const empresa of empresas) {
      const clean = empresa.cep.replace(/[^\d]/g, '');
      if (clean.length !== 8) { stats.sem_cep++; continue; }

      const cepData = cepCache[clean];
      if (!cepData) { stats.cep_nao_encontrado++; continue; }

      const key = `${cepData.city.toLowerCase()}|${cepData.state}`;
      const geo = municipioByNomeCache.get(key);
      if (!geo) { stats.municipio_nao_match++; continue; }

      const codigoIbge = String(geo.codigo_ibge);
      updates.push({
        id: empresa.id,
        update: {
          codigo_ibge: codigoIbge,
          codigo_ibge_uf: codigoIbge.substring(0, 2),
          latitude: geo.latitude,
          longitude: geo.longitude,
          cidade: geo.nome,
          estado: geo.sigla
        }
      });
    }

    // Batch update
    if (updates.length > 0 && !DRY_RUN) {
      for (let j = 0; j < updates.length; j += GEO_CONCURRENT) {
        const chunk = updates.slice(j, j + GEO_CONCURRENT);
        const results = await Promise.all(
          chunk.map(item => supabase.from('dim_empresas').update(item.update).eq('id', item.id))
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
          console.log(`  [DRY] id:${item.id} → ibge:${item.update.codigo_ibge} ${item.update.cidade}/${item.update.estado}`);
        }
        if (updates.length > 3) console.log(`  [DRY] ... +${updates.length - 3}`);
      }
    }

    saveCache(CEP_CACHE_FILE, cepCache);
    if (empresas.length < PAGE_SIZE) hasMore = false;
    offset += PAGE_SIZE;
  }

  console.log(`[FASE1] Resultado: ${stats.atualizadas}/${stats.total} atualizadas | ${stats.erros} erros`);
  return stats;
}

// ============================================================
// FASE 2: CIDADE/ESTADO (codigo_ibge → geo_municipios)
// ============================================================

async function fase2CidadeEstado() {
  console.log('\n' + '='.repeat(60));
  console.log('  FASE 2: CIDADE/ESTADO (codigo_ibge → nome, UF)');
  console.log('='.repeat(60));

  const stats = { total: 0, atualizadas: 0, sem_match: 0, erros: 0 };

  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: empresas, error } = await supabase
      .from('dim_empresas')
      .select('id, codigo_ibge')
      .not('codigo_ibge', 'is', null)
      .or('cidade.is.null,estado.is.null')
      .range(offset, offset + PAGE_SIZE - 1)
      .order('id');

    if (error) { console.error('[FASE2] Erro:', error.message); break; }
    if (!empresas || empresas.length === 0) { hasMore = false; break; }

    stats.total += empresas.length;
    console.log(`[FASE2] Lote ${Math.floor(offset / PAGE_SIZE) + 1}: ${empresas.length} empresas`);

    const updates = [];
    for (const empresa of empresas) {
      const geo = municipioByIbgeCache.get(String(empresa.codigo_ibge));
      if (!geo) { stats.sem_match++; continue; }

      updates.push({
        id: empresa.id,
        update: {
          cidade: geo.nome,
          estado: geo.sigla
        }
      });
    }

    if (updates.length > 0 && !DRY_RUN) {
      for (let j = 0; j < updates.length; j += GEO_CONCURRENT) {
        const chunk = updates.slice(j, j + GEO_CONCURRENT);
        const results = await Promise.all(
          chunk.map(item => supabase.from('dim_empresas').update(item.update).eq('id', item.id))
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
          console.log(`  [DRY] id:${item.id} → ${item.update.cidade}/${item.update.estado}`);
        }
        if (updates.length > 3) console.log(`  [DRY] ... +${updates.length - 3}`);
      }
    }

    if (empresas.length < PAGE_SIZE) hasMore = false;
    offset += PAGE_SIZE;
  }

  console.log(`[FASE2] Resultado: ${stats.atualizadas}/${stats.total} atualizadas | ${stats.erros} erros`);
  return stats;
}

// ============================================================
// FASE 3: WEBSITE (Perplexity AI)
// ============================================================

async function searchWebsitePerplexity(cnpj, razaoSocial, nomeFantasia) {
  const cacheKey = cnpj.replace(/[^\d]/g, '');
  if (websiteCache[cacheKey] !== undefined) return websiteCache[cacheKey];

  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'your_perplexity_api_key_here') {
    console.warn('[FASE3] PERPLEXITY_API_KEY nao configurada');
    return null;
  }

  const nomeEmpresa = nomeFantasia || razaoSocial || '';
  const cnpjFormatted = formatCnpj(cnpj);

  const prompt = `Qual é o site oficial (website) da empresa brasileira "${nomeEmpresa}" com CNPJ ${cnpjFormatted}?

Regras:
- Retorne APENAS o domínio principal (ex: https://www.empresa.com.br)
- NÃO retorne redes sociais (facebook, instagram, linkedin)
- NÃO retorne páginas de diretórios (jusbrasil, cnpj.info, econodata)
- Se a empresa não tiver site próprio, retorne "SEM_WEBSITE"
- Retorne APENAS um JSON válido, sem texto adicional

Formato:
{"website": "https://www.exemplo.com.br"}
ou
{"website": "SEM_WEBSITE"}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            {
              role: 'system',
              content: 'Você busca websites oficiais de empresas brasileiras. Retorne APENAS JSON válido.'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 200
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (resp.status === 429) {
        const wait = Math.pow(2, attempt) * 5000;
        console.log(`  [RATE] Rate limited, aguardando ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!resp.ok) {
        console.error(`  [PERPLEXITY] HTTP ${resp.status}`);
        websiteCache[cacheKey] = null;
        return null;
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';

      // Parse JSON
      const jsonMatch = content.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          const website = parsed.website;

          if (!website || website === 'SEM_WEBSITE') {
            websiteCache[cacheKey] = null;
            return null;
          }

          // Validar que é URL válida e não é rede social/diretório
          if (isValidWebsite(website)) {
            websiteCache[cacheKey] = website;
            return website;
          }

          websiteCache[cacheKey] = null;
          return null;
        } catch {
          websiteCache[cacheKey] = null;
          return null;
        }
      }

      websiteCache[cacheKey] = null;
      return null;
    } catch (err) {
      if (attempt < 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  websiteCache[cacheKey] = null;
  return null;
}

function isValidWebsite(url) {
  if (!url || typeof url !== 'string') return false;

  const blocked = [
    'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
    'youtube.com', 'tiktok.com', 'whatsapp.com',
    'jusbrasil.com', 'cnpj.info', 'econodata.com', 'speedio.com',
    'consultasocio.com', 'casadosdados.com', 'cnpja.com', 'cnpj.biz',
    'empresaqui.com', 'infoplex.com', 'receitafederal.gov.br'
  ];

  const lower = url.toLowerCase();
  return blocked.every(domain => !lower.includes(domain));
}

function formatCnpj(cnpj) {
  const digits = cnpj.replace(/[^\d]/g, '');
  if (digits.length !== 14) return cnpj;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

async function fase3Website() {
  console.log('\n' + '='.repeat(60));
  console.log('  FASE 3: WEBSITE (Perplexity AI)');
  if (WORKER_TOTAL > 1) console.log(`  Worker: ${WORKER_ID + 1}/${WORKER_TOTAL}`);
  if (WEBSITE_LIMIT > 0) console.log(`  Limite: ${WEBSITE_LIMIT} empresas`);
  console.log('='.repeat(60));

  if (!PERPLEXITY_API_KEY || PERPLEXITY_API_KEY === 'your_perplexity_api_key_here') {
    console.error('[FASE3] PERPLEXITY_API_KEY nao configurada. Pulando.');
    return { total: 0, atualizadas: 0, sem_website: 0, erros: 0 };
  }

  const stats = { total: 0, atualizadas: 0, sem_website: 0, cache_hits: 0, erros: 0, skipped_worker: 0 };

  let offset = 0;
  let hasMore = true;
  let processed = 0;

  while (hasMore) {
    const effectiveLimit = WEBSITE_LIMIT > 0
      ? Math.min(PAGE_SIZE, WEBSITE_LIMIT - processed)
      : PAGE_SIZE;

    if (effectiveLimit <= 0) break;

    const { data: empresas, error } = await supabase
      .from('dim_empresas')
      .select('id, cnpj, razao_social, nome_fantasia')
      .or('website.is.null,website.eq.')
      .range(offset, offset + PAGE_SIZE - 1)
      .order('id');

    if (error) { console.error('[FASE3] Erro:', error.message); break; }
    if (!empresas || empresas.length === 0) { hasMore = false; break; }

    // Worker mode: filtrar por hash do ID para dividir trabalho
    let filteredEmpresas = empresas;
    if (WORKER_TOTAL > 1) {
      filteredEmpresas = empresas.filter(e => {
        // Hash simples: soma dos char codes do UUID mod WORKER_TOTAL
        const hash = e.id.split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
        return (hash % WORKER_TOTAL) === WORKER_ID;
      });
      stats.skipped_worker += empresas.length - filteredEmpresas.length;
    }

    // Aplicar limite ao filtrado
    if (WEBSITE_LIMIT > 0) {
      const remaining = WEBSITE_LIMIT - processed;
      filteredEmpresas = filteredEmpresas.slice(0, remaining);
    }

    stats.total += filteredEmpresas.length;
    console.log(`[FASE3] Lote ${Math.floor(offset / PAGE_SIZE) + 1}: ${filteredEmpresas.length} empresas (de ${empresas.length})`);

    // Processar em sequencia com delay (rate limit Perplexity)
    for (let i = 0; i < filteredEmpresas.length; i += PERPLEXITY_CONCURRENT) {
      const chunk = filteredEmpresas.slice(i, i + PERPLEXITY_CONCURRENT);

      const results = await Promise.all(
        chunk.map(async (empresa) => {
          const cacheKey = empresa.cnpj.replace(/[^\d]/g, '');
          const cached = websiteCache[cacheKey];

          if (cached !== undefined) {
            stats.cache_hits++;
            return { id: empresa.id, website: cached, cnpj: empresa.cnpj };
          }

          const website = await searchWebsitePerplexity(
            empresa.cnpj,
            empresa.razao_social,
            empresa.nome_fantasia
          );
          return { id: empresa.id, website, cnpj: empresa.cnpj };
        })
      );

      // Update
      for (const result of results) {
        if (result.website) {
          if (!DRY_RUN) {
            const { error: updateError } = await supabase
              .from('dim_empresas')
              .update({ website: result.website })
              .eq('id', result.id);

            if (updateError) {
              stats.erros++;
            } else {
              stats.atualizadas++;
              console.log(`  [OK] ${result.cnpj} → ${result.website}`);
            }
          } else {
            stats.atualizadas++;
            console.log(`  [DRY] ${result.cnpj} → ${result.website}`);
          }
        } else {
          stats.sem_website++;
        }
      }

      // Delay entre batches para rate limit
      if (i + PERPLEXITY_CONCURRENT < filteredEmpresas.length) {
        await new Promise(r => setTimeout(r, PERPLEXITY_DELAY_MS));
      }
    }

    // Salvar cache periodicamente
    saveCache(WEBSITE_CACHE_FILE, websiteCache);

    processed += filteredEmpresas.length;
    if (WEBSITE_LIMIT > 0 && processed >= WEBSITE_LIMIT) break;
    if (empresas.length < PAGE_SIZE) hasMore = false;
    offset += PAGE_SIZE;
  }

  saveCache(WEBSITE_CACHE_FILE, websiteCache);

  console.log(`[FASE3] Resultado: ${stats.atualizadas} websites encontrados | ${stats.sem_website} sem website | ${stats.cache_hits} cache hits | ${stats.erros} erros`);
  return stats;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log('  BACKFILL COMPLETO - dim_empresas');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'PRODUCAO'}`);
  console.log(`  Fases: ${FASES_ATIVAS.join(', ')}`);
  if (WEBSITE_LIMIT > 0) console.log(`  Limite website: ${WEBSITE_LIMIT}`);
  console.log('='.repeat(60));

  // Carregar caches
  cepCache = loadCache(CEP_CACHE_FILE);
  websiteCache = loadCache(WEBSITE_CACHE_FILE);
  console.log(`[CACHE] CEP: ${Object.keys(cepCache).length} | Website: ${Object.keys(websiteCache).length}`);

  // Pre-carregar municipios (necessario para fase 1 e 2)
  if (FASES_ATIVAS.includes(1) || FASES_ATIVAS.includes(2)) {
    const total = await preloadMunicipios();
    if (total === 0) {
      console.error('[ERRO] Nenhum municipio encontrado. Verifique BRASIL_DATA_HUB_URL/KEY.');
      process.exit(1);
    }
  }

  const resultados = {};

  // FASE 1: Geo
  if (FASES_ATIVAS.includes(1)) {
    resultados.fase1 = await fase1Geo();
  }

  // FASE 2: Cidade/Estado
  if (FASES_ATIVAS.includes(2)) {
    resultados.fase2 = await fase2CidadeEstado();
  }

  // FASE 3: Website
  if (FASES_ATIVAS.includes(3)) {
    resultados.fase3 = await fase3Website();
  }

  // Relatorio final
  console.log('\n' + '='.repeat(60));
  console.log('  RELATORIO FINAL');
  console.log('='.repeat(60));

  if (resultados.fase1) {
    console.log(`  FASE 1 (Geo):      ${resultados.fase1.atualizadas} atualizadas | ${resultados.fase1.erros} erros`);
  }
  if (resultados.fase2) {
    console.log(`  FASE 2 (Cidade):   ${resultados.fase2.atualizadas} atualizadas | ${resultados.fase2.erros} erros`);
  }
  if (resultados.fase3) {
    console.log(`  FASE 3 (Website):  ${resultados.fase3.atualizadas} encontrados | ${resultados.fase3.sem_website} sem site | ${resultados.fase3.erros} erros`);
  }

  if (DRY_RUN) {
    console.log('\n  [DRY RUN] Nenhuma alteracao salva. Rode sem --dry-run para aplicar.');
  }

  console.log('='.repeat(60));
}

main().catch(err => {
  saveCache(CEP_CACHE_FILE, cepCache);
  saveCache(WEBSITE_CACHE_FILE, websiteCache);
  console.error('[FATAL]', err);
  process.exit(1);
});
