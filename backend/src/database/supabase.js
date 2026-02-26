import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from '../utils/logger.js';

// Ensure dotenv is loaded (ESM modules load before code execution)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseKey) missing.push('SUPABASE_SERVICE_KEY');
  logger.error('Missing required Supabase credentials', { missing });
  throw new Error(`Missing required environment variables: ${missing.join(', ')}. Check your .env file.`);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Insert company into dim_empresas
 * Sources: BrasilAPI (official) + Serper (enrichment)
 * @param {Object} company - Company data
 * @returns {Promise<Object>} Inserted company
 */
export async function insertCompany(company) {
  const { data, error } = await supabase
    .from('dim_empresas')
    .insert([{
      // Identification
      cnpj: company.cnpj,
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
      cidade: company.cidade,
      estado: company.estado,
      cep: company.cep,
      codigo_municipio_ibge: company.codigo_municipio_ibge,

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
 * Insert person into dim_pessoas
 * CPF from BrasilAPI QSA, LinkedIn from Serper
 * @param {Object} person - Person data
 * @returns {Promise<Object>} Inserted person
 */
export async function insertPerson(person) {
  // Extract first and last name
  const nameParts = (person.nome || '').split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const { data, error } = await supabase
    .from('dim_pessoas')
    .insert([{
      // Name
      nome_completo: person.nome,
      primeiro_nome: firstName,
      sobrenome: lastName,

      // CPF from BrasilAPI QSA
      cpf: person.cpf,

      // LinkedIn and contact
      linkedin_url: person.linkedin,
      email: person.email,
      foto_url: person.foto_url,

      // BrasilAPI QSA fields
      faixa_etaria: person.faixa_etaria,
      pais: person.pais_origem || 'Brasil',

      // Raw data
      raw_apollo_data: person.raw_apollo,

      // Metadata
      fonte: 'brasilapi+serper+apollo',
      data_coleta: new Date().toISOString()
    }])
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

/**
 * List all companies with optional filters
 * @param {Object} filters - Optional filters: nome, cidade, segmento, regime
 */
export async function listCompanies(filters = {}) {
  const { nome, cidade, empresaIds, limit = 100, offset = 0 } = filters;

  const from = offset;
  const to = offset + limit - 1;

  const hasFilter = !!(nome || cidade || empresaIds);

  let query = supabase
    .from('dim_empresas')
    .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral, linkedin_url')
    .range(from, to);

  // Only ORDER BY when listing without filters (uses PK index, fast)
  // With ilike filters, skip ORDER to let Postgres pick fastest plan
  if (!hasFilter) {
    query = query.order('id', { ascending: false });
  }

  if (nome) {
    // Split search terms and filter out Portuguese stop words
    const stopWords = new Set(['e', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'a', 'o', 'os', 'as', 'um', 'uma', 'para', 'com', 'por']);
    const words = nome.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w.toLowerCase()));

    if (words.length > 0) {
      // Use prefix match (word%) when possible for index usage, fallback to contains (%word%)
      for (const word of words) {
        query = query.or(`razao_social.ilike.${word}%,nome_fantasia.ilike.${word}%,razao_social.ilike.% ${word}%,nome_fantasia.ilike.% ${word}%`);
      }
    } else {
      query = query.or(`razao_social.ilike.${nome}%,nome_fantasia.ilike.${nome}%`);
    }
  }

  if (cidade) {
    query = query.ilike('cidade', `${cidade}%`);
  }

  if (empresaIds && empresaIds.length > 0) {
    query = query.in('id', empresaIds);
  }

  const { data, error } = await query;

  if (error) throw error;

  return { data: data || [], total: (data || []).length };
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
