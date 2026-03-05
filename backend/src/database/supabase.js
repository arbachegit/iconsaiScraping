import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';
import { SEARCH_STOP_WORDS } from '../constants.js';

// Ensure dotenv is loaded (ESM modules load before code execution)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const readReplicaUrl = process.env.SUPABASE_READ_REPLICA_URL;

if (!supabaseUrl || !supabaseKey) {
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseKey) missing.push('SUPABASE_SERVICE_KEY');
  logger.error('Missing required Supabase credentials', { missing });
  throw new Error(`Missing required environment variables: ${missing.join(', ')}. Check your .env file.`);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Read replica client for heavy read queries (stats, search, graph traversal).
 * Falls back to primary if SUPABASE_READ_REPLICA_URL is not set.
 */
export const supabaseRead = readReplicaUrl
  ? createClient(readReplicaUrl, supabaseKey)
  : supabase;

if (readReplicaUrl) {
  logger.info('Supabase read replica configured', { url: readReplicaUrl.replace(/\/\/.*@/, '//***@') });
}

/**
 * Insert company into dim_empresas
 * Sources: BrasilAPI (official) + Serper (enrichment)
 * @param {Object} company - Company data
 * @returns {Promise<Object>} Inserted company
 */
export async function insertCompany(company) {
  // Normalize CNPJ: remove non-digits
  const cleanCnpj = company.cnpj ? String(company.cnpj).replace(/[^\d]/g, '') : company.cnpj;

  const { data, error } = await supabase
    .from('dim_empresas')
    .insert([{
      // Identification
      cnpj: cleanCnpj,
      razao_social: company.razao_social,
      nome_fantasia: company.nome_fantasia,

      // Status
      situacao_cadastral: company.situacao_cadastral,
      data_abertura: company.data_fundacao,
      data_fundacao: company.data_fundacao,

      // Address (BrasilAPI)
      logradouro: company.logradouro,
      numero: company.numero,
      complemento: company.complemento,
      bairro: company.bairro,
      cep: company.cep,
      codigo_ibge: company.codigo_municipio_ibge || company.codigo_ibge,
      cidade: company.cidade,
      estado: company.estado,

      // Contact (BrasilAPI)
      telefone: company.telefone_1,
      telefone_1: company.telefone_1,
      telefone_2: company.telefone_2,
      email: company.email,

      // Digital presence
      website: company.website,
      linkedin_url: company.linkedin,

      // Raw data
      raw_cnpj_data: company.raw_brasilapi,
      raw_brasilapi: company.raw_brasilapi,
      raw_apollo: company.raw_apollo,

      // Metadata
      fonte: 'brasilapi+serper+apollo',
      data_coleta: new Date().toISOString(),
      aprovado_por: company.aprovado_por
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Insert or update person in dim_pessoas.
 * If CPF exists, updates with new data (keeping non-null fields).
 * If no CPF or CPF not found, inserts new record.
 * @param {Object} person - Person data
 * @returns {Promise<Object>} Inserted or updated person
 */
export async function insertPerson(person) {
  // Normalize CPF: remove non-digits, null if empty/masked
  const rawCpf = person.cpf ? String(person.cpf).replace(/[^\d]/g, '') : null;
  const cpf = rawCpf && rawCpf.length === 11 && !rawCpf.includes('0'.repeat(11)) ? rawCpf : null;

  // Extract first and last name
  const nameParts = (person.nome || '').split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const record = {
    nome_completo: person.nome,
    primeiro_nome: firstName,
    sobrenome: lastName,
    cpf,
    linkedin_url: person.linkedin,
    email: person.email,
    foto_url: person.foto_url,
    faixa_etaria: person.faixa_etaria,
    pais: person.pais_origem || 'Brasil',
    raw_apollo_data: person.raw_apollo,
    fonte: 'brasilapi+serper+apollo',
    data_coleta: new Date().toISOString()
  };

  // If CPF is available, try to find existing person first
  if (cpf) {
    const { data: existing } = await supabase
      .from('dim_pessoas')
      .select('*')
      .eq('cpf', cpf)
      .maybeSingle();

    if (existing) {
      // Update only fields that are non-null in the new data
      const updates = {};
      for (const [key, value] of Object.entries(record)) {
        if (value != null && value !== '' && key !== 'cpf') {
          updates[key] = value;
        }
      }
      updates.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('dim_pessoas')
        .update(updates)
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    }
  }

  // No CPF or person not found: insert new
  const { data, error } = await supabase
    .from('dim_pessoas')
    .insert([record])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Insert transaction into fato_transacao_empresas
 * @param {Object} transacao - Transaction data
 * @returns {Promise<Object>} Inserted transaction
 */
export async function insertTransacaoEmpresa(transacao) {
  const { data, error } = await supabase
    .from('fato_transacao_empresas')
    .insert([{
      pessoa_id: transacao.pessoa_id,
      empresa_id: transacao.empresa_id,
      tipo_transacao: transacao.tipo_transacao || 'entrada_sociedade',
      data_transacao: transacao.data_transacao,
      qualificacao: transacao.qualificacao,
      cargo: transacao.cargo,
      headline: transacao.headline,
      tipo: transacao.tipo || 'fundador',
      logo_url: transacao.logo_url,
      ativo: transacao.ativo ?? true
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Insert regime tributario into fato_regime_tributario
 */
export async function insertRegimeTributario(regime) {
  const { data, error } = await supabase
    .from('fato_regime_tributario')
    .insert([{
      empresa_id: regime.empresa_id,
      porte: regime.porte,
      natureza_juridica: regime.natureza_juridica,
      capital_social: regime.capital_social,
      cnae_principal: regime.cnae_principal,
      cnae_descricao: regime.cnae_descricao,
      regime_tributario: regime.regime_tributario,
      setor: regime.setor,
      descricao: regime.descricao,
      qtd_funcionarios: regime.qtd_funcionarios,
      // New fields
      data_inicio: regime.data_inicio,
      data_fim: regime.data_fim,
      ativo: regime.ativo !== false,
      motivo_exclusao: regime.motivo_exclusao,
      simples_optante: regime.simples_optante,
      simples_desde: regime.simples_desde,
      mei_optante: regime.mei_optante,
      mei_desde: regime.mei_desde,
      raw_cnpja: regime.raw_cnpja || {}
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Insert historical regime records (bulk)
 */
export async function insertRegimeHistorico(empresa_id, historico, dadosBase) {
  const records = historico.map(h => ({
    empresa_id,
    regime_tributario: h.regime,
    data_inicio: h.data_inicio,
    data_fim: h.data_fim,
    ativo: h.ativo,
    motivo_exclusao: h.motivo_exclusao,
    porte: dadosBase.porte,
    natureza_juridica: dadosBase.natureza_juridica,
    capital_social: dadosBase.capital_social,
    cnae_principal: dadosBase.cnae_principal,
    cnae_descricao: dadosBase.cnae_descricao
  }));

  const { data, error } = await supabase
    .from('fato_regime_tributario')
    .insert(records)
    .select();

  if (error) throw error;
  return data;
}

/**
 * Insert inference about limits
 */
export async function insertInferenciaLimites(inferencia) {
  const { data, error } = await supabase
    .from('fato_inferencia_limites')
    .insert([{
      empresa_id: inferencia.empresa_id,
      provavelmente_ultrapassou_limite: inferencia.provavelmente_ultrapassou_limite,
      confianca: inferencia.confianca,
      sinais: inferencia.sinais,
      qtd_mudancas_regime: inferencia.qtd_mudancas_regime,
      capital_social: inferencia.capital_social,
      qtd_funcionarios: inferencia.qtd_funcionarios,
      anos_operando: inferencia.anos_operando
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Check if company exists by CNPJ
 * @param {string} cnpj - Company CNPJ
 * @returns {Promise<Object|null>} Company or null
 */
export async function findCompanyByCnpj(cnpj) {
  const { data, error } = await supabase
    .from('dim_empresas')
    .select('*')
    .eq('cnpj', cnpj)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

// -----------------------------------------------------------------------
// Approved companies cache (in-memory)
// dim_empresas has 64M+ rows from Receita Federal bulk import.
// ILIKE on 64M rows without GIN indexes always times out.
// We cache the ~5000 approved companies (those with fato_transacao_empresas)
// and filter in JS. Cache TTL: 5 minutes.
// -----------------------------------------------------------------------
let _approvedCache = null;
let _approvedCacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getApprovedCompanies() {
  if (_approvedCache && Date.now() < _approvedCacheExpiry) {
    return _approvedCache;
  }

  // Fetch all transacao rows with JOIN to dim_empresas (paginated, max 1000/page)
  const seen = new Set();
  const companies = [];
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('fato_transacao_empresas')
      .select('empresa_id, dim_empresas(id, razao_social, nome_fantasia, cnpj, cidade, estado, situacao_cadastral, linkedin_url, cep, codigo_ibge, fonte)')
      .range(from, to);

    if (error || !data || data.length === 0) break;

    for (const row of data) {
      if (seen.has(row.empresa_id) || !row.dim_empresas) continue;
      seen.add(row.empresa_id);
      companies.push(row.dim_empresas);
    }

    if (data.length < pageSize) break;
    page++;
  }

  // Fetch regime data - single query since fato_regime_tributario is small (~6 rows ativo)
  const regimeMap = new Map();
  const { data: regimeRows } = await supabase
    .from('fato_regime_tributario')
    .select('empresa_id, regime_tributario, cnae_descricao')
    .eq('ativo', true)
    .limit(10000);
  for (const r of (regimeRows || [])) {
    if (!regimeMap.has(r.empresa_id)) {
      regimeMap.set(r.empresa_id, r);
    }
  }

  // Merge regime data
  const enriched = companies.map(c => {
    const regime = regimeMap.get(c.id);
    return {
      ...c,
      cidade: c.cidade ?? null,
      estado: c.estado ?? null,
      regime_tributario: regime?.regime_tributario || null,
      cnae_descricao: regime?.cnae_descricao || null,
      linkedin: c.linkedin_url || null,
    };
  });

  _approvedCache = enriched;
  _approvedCacheExpiry = Date.now() + CACHE_TTL_MS;
  logger.info('approved_cache_refreshed', { companies: enriched.length });

  return enriched;
}

/**
 * Invalidate the approved companies cache (call after approving a new company)
 */
export function invalidateApprovedCache() {
  _approvedCache = null;
  _approvedCacheExpiry = 0;
}

/**
 * Eagerly warm the approved companies cache at startup.
 * Call this during server init so the first user request doesn't wait ~10s.
 */
export async function warmApprovedCache() {
  try {
    const companies = await getApprovedCompanies();
    logger.info('approved_cache_warmed_at_startup', { companies: companies.length });
  } catch (err) {
    logger.warn('approved_cache_warmup_failed', { error: err.message });
  }
}

/**
 * List all companies with optional filters
 * Searches only approved companies (those with fato_transacao_empresas records)
 * @param {Object} filters - Optional filters: nome, cidade, segmento, regime, empresaIds, limit, offset
 */
export async function listCompanies(filters = {}) {
  const { nome, cidade, segmento, regime, empresaIds, limit = 100, offset = 0 } = filters;

  let companies = await getApprovedCompanies();

  // Apply text filters in JS
  if (nome) {
    const words = nome.split(/\s+/).filter(w => w.length >= 2 && !SEARCH_STOP_WORDS.has(w.toLowerCase()));
    const termsToSearch = words.length > 0 ? words : [nome];
    companies = companies.filter(c => {
      const text = ((c.razao_social || '') + ' ' + (c.nome_fantasia || '')).toLowerCase();
      return termsToSearch.every(t => text.includes(t.toLowerCase()));
    });
  }

  if (cidade) {
    const cl = cidade.toLowerCase();
    companies = companies.filter(c => (c.cidade || '').toLowerCase().includes(cl));
  }

  if (segmento) {
    const sl = segmento.toLowerCase();
    companies = companies.filter(c => (c.cnae_descricao || '').toLowerCase().includes(sl));
  }

  if (regime) {
    const rl = regime.toLowerCase();
    companies = companies.filter(c => (c.regime_tributario || '').toLowerCase().includes(rl));
  }

  if (empresaIds && empresaIds.length > 0) {
    const idSet = new Set(empresaIds);
    companies = companies.filter(c => idSet.has(c.id));
  }

  companies = [...companies].sort((a, b) => {
    const aName = (a.nome_fantasia || a.razao_social || '').toLowerCase();
    const bName = (b.nome_fantasia || b.razao_social || '').toLowerCase();
    if (aName !== bName) return aName.localeCompare(bName);
    return String(a.id).localeCompare(String(b.id));
  });

  const total = companies.length;
  const paginated = companies.slice(offset, offset + limit);

  return { data: paginated, total };
}

/**
 * Check which CNPJs already exist in dim_empresas (batch)
 * @param {string[]} cnpjs - Array of CNPJs to check
 * @returns {Promise<Set<string>>} Set of existing CNPJs
 */
export async function checkExistingCnpjs(cnpjs) {
  if (!cnpjs || cnpjs.length === 0) return new Set();

  const cleaned = cnpjs.map(c => c.replace(/[^\d]/g, '')).filter(c => c.length === 14);
  if (cleaned.length === 0) return new Set();

  const { data, error } = await supabase
    .from('dim_empresas')
    .select('cnpj')
    .in('cnpj', cleaned);

  if (error) throw error;
  return new Set((data || []).map(d => d.cnpj));
}

/**
 * Get company with all related data for VAR analysis
 */
export async function getCompanyFullData(empresa_id) {
  // Company
  const { data: empresa, error: e1 } = await supabase
    .from('dim_empresas')
    .select('*')
    .eq('id', empresa_id)
    .single();
  if (e1) throw e1;

  // Regime history
  const { data: regimes, error: e2 } = await supabase
    .from('fato_regime_tributario')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('data_inicio', { ascending: true });
  if (e2 && e2.code !== 'PGRST116') throw e2;

  // Inferences
  const { data: inferencias, error: e3 } = await supabase
    .from('fato_inferencia_limites')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('data_analise', { ascending: false });
  if (e3 && e3.code !== 'PGRST116') throw e3;

  // Partners (socios)
  const { data: transacoes, error: e4 } = await supabase
    .from('fato_transacao_empresas')
    .select('*, dim_pessoas(*)')
    .eq('empresa_id', empresa_id);
  if (e4 && e4.code !== 'PGRST116') throw e4;

  return {
    empresa,
    regimes: regimes || [],
    inferencias: inferencias || [],
    socios: transacoes || []
  };
}

/**
 * Register data source for compliance (ISO 27001/27701)
 * OBRIGATÓRIO: Todo scraping deve registrar fonte
 */
export async function registerDataSource(source) {
  const { data: existing } = await supabase
    .from('fontes_dados')
    .select('id')
    .eq('nome', source.nome)
    .single();

  if (existing) {
    // Update last collection date
    const { error } = await supabase
      .from('fontes_dados')
      .update({
        data_ultima_atualizacao: new Date().toISOString()
      })
      .eq('id', existing.id);
    if (error) console.error('[FONTE] Erro ao atualizar:', error.message);
    return existing;
  }

  const { data, error } = await supabase
    .from('fontes_dados')
    .insert([{
      nome: source.nome,
      categoria: source.categoria || 'scraping',
      fonte_primaria: source.fonte_primaria,
      url: source.url,
      documentacao_url: source.documentacao_url,
      data_primeira_coleta: new Date().toISOString(),
      periodicidade: source.periodicidade || 'sob_demanda',
      formato: source.formato || 'JSON',
      autenticacao_requerida: source.autenticacao_requerida || false,
      api_key_necessaria: source.api_key_necessaria || false,
      confiabilidade: source.confiabilidade || 'alta',
      cobertura_temporal: source.cobertura_temporal,
      observacoes: source.observacoes
    }])
    .select()
    .single();

  if (error) {
    console.error('[FONTE] Erro ao registrar:', error.message);
    return null;
  }

  console.log(`[FONTE] Registrada: ${source.nome}`);
  return data;
}

/**
 * Update inference for a company
 */
export async function updateInferenciaLimites(empresa_id, inferencia) {
  // Check if exists
  const { data: existing } = await supabase
    .from('fato_inferencia_limites')
    .select('id')
    .eq('empresa_id', empresa_id)
    .single();

  if (existing) {
    const { data, error } = await supabase
      .from('fato_inferencia_limites')
      .update({
        provavelmente_ultrapassou_limite: inferencia.provavelmente_ultrapassou_limite,
        confianca: inferencia.confianca,
        sinais: inferencia.sinais,
        faturamento_estimado_min: inferencia.faturamento_estimado_min,
        faturamento_estimado_max: inferencia.faturamento_estimado_max,
        probabilidade_mudanca_regime: inferencia.probabilidade_mudanca_regime,
        regime_provavel_proximo: inferencia.regime_provavel_proximo,
        variaveis_correlacionadas: inferencia.variaveis_correlacionadas,
        data_analise: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    return insertInferenciaLimites({ empresa_id, ...inferencia });
  }
}
