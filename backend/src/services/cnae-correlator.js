/**
 * CNAE Correlator Service
 * Analyzes company positioning in the value chain based on CNAE codes.
 * Identifies typical clients, suppliers, and competitors by CNAE correlation.
 *
 * Uses existing data from dim_empresas — no external API dependency.
 */

import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { sanitizeUUID } from '../utils/sanitize.js';
import { CNAE_SECTOR_MAP } from '../constants.js';
import { createEvidence } from './evidence-manager.js';

/**
 * CNAE value chain mapping.
 * Maps CNAE divisions (2-digit) to their typical position in the value chain
 * and their typical client/supplier CNAE divisions.
 */
const CNAE_CHAIN = {
  // Indústria de base → fornece para indústria de transformação
  '05': { cadeia: 'producao', posicao: 'inicio', clientes: ['24','25','23'], fornecedores: [] },
  '07': { cadeia: 'producao', posicao: 'inicio', clientes: ['24','25','23'], fornecedores: [] },
  '08': { cadeia: 'producao', posicao: 'inicio', clientes: ['23','41','42'], fornecedores: [] },
  // Alimentos
  '10': { cadeia: 'producao', posicao: 'meio', clientes: ['46','47','56'], fornecedores: ['01','03'] },
  '11': { cadeia: 'producao', posicao: 'meio', clientes: ['46','47','56'], fornecedores: ['01'] },
  // Têxtil/Vestuário
  '13': { cadeia: 'producao', posicao: 'meio', clientes: ['14','46','47'], fornecedores: ['01','20'] },
  '14': { cadeia: 'producao', posicao: 'fim', clientes: ['46','47'], fornecedores: ['13'] },
  // Madeira/Papel
  '16': { cadeia: 'producao', posicao: 'meio', clientes: ['31','17','41'], fornecedores: ['02'] },
  '17': { cadeia: 'producao', posicao: 'meio', clientes: ['18','46','47'], fornecedores: ['16','02'] },
  // Química/Farmacêutica
  '20': { cadeia: 'producao', posicao: 'meio', clientes: ['21','22','13','10'], fornecedores: ['05','06','07'] },
  '21': { cadeia: 'producao', posicao: 'fim', clientes: ['46','47','86'], fornecedores: ['20'] },
  // Borracha/Plástico
  '22': { cadeia: 'producao', posicao: 'meio', clientes: ['29','30','41','47'], fornecedores: ['20'] },
  // Minerais não-metálicos
  '23': { cadeia: 'producao', posicao: 'meio', clientes: ['41','42','43'], fornecedores: ['08'] },
  // Metalurgia
  '24': { cadeia: 'producao', posicao: 'meio', clientes: ['25','28','29','30'], fornecedores: ['05','07'] },
  '25': { cadeia: 'producao', posicao: 'meio', clientes: ['28','29','41','43'], fornecedores: ['24'] },
  // Eletrônicos
  '26': { cadeia: 'producao', posicao: 'fim', clientes: ['46','47','62'], fornecedores: ['27'] },
  '27': { cadeia: 'producao', posicao: 'meio', clientes: ['26','43','46','47'], fornecedores: ['24','25'] },
  // Máquinas
  '28': { cadeia: 'producao', posicao: 'fim', clientes: ['01','10','24','41'], fornecedores: ['24','25','27'] },
  // Automotivo
  '29': { cadeia: 'producao', posicao: 'fim', clientes: ['45','46','49'], fornecedores: ['22','24','25','27'] },
  '30': { cadeia: 'producao', posicao: 'fim', clientes: ['45','46','50','51'], fornecedores: ['22','24','25'] },
  // Móveis
  '31': { cadeia: 'producao', posicao: 'fim', clientes: ['46','47'], fornecedores: ['16'] },
  // Construção
  '41': { cadeia: 'producao', posicao: 'fim', clientes: ['68'], fornecedores: ['23','25','27','43'] },
  '42': { cadeia: 'producao', posicao: 'fim', clientes: ['84'], fornecedores: ['23','25','28'] },
  '43': { cadeia: 'servicos', posicao: 'meio', clientes: ['41','42'], fornecedores: ['25','27'] },
  // Comércio
  '45': { cadeia: 'distribuicao', posicao: 'fim', clientes: [], fornecedores: ['29','30'] },
  '46': { cadeia: 'distribuicao', posicao: 'meio', clientes: ['47','56'], fornecedores: ['10','11','14','21','26','31'] },
  '47': { cadeia: 'varejo', posicao: 'fim', clientes: [], fornecedores: ['46','10','14','26'] },
  // Transporte/Logística
  '49': { cadeia: 'servicos', posicao: 'meio', clientes: ['10','46','47'], fornecedores: ['29'] },
  '52': { cadeia: 'servicos', posicao: 'meio', clientes: ['46','47','10'], fornecedores: [] },
  // Hospedagem/Alimentação
  '55': { cadeia: 'servicos', posicao: 'fim', clientes: [], fornecedores: ['46','47'] },
  '56': { cadeia: 'servicos', posicao: 'fim', clientes: [], fornecedores: ['10','11','46'] },
  // TI
  '62': { cadeia: 'servicos', posicao: 'fim', clientes: ['64','86','47','10'], fornecedores: ['26'] },
  '63': { cadeia: 'servicos', posicao: 'fim', clientes: ['62','64','73'], fornecedores: [] },
  // Financeiro
  '64': { cadeia: 'servicos', posicao: 'fim', clientes: [], fornecedores: ['62','63'] },
  '65': { cadeia: 'servicos', posicao: 'fim', clientes: [], fornecedores: ['62'] },
  // Imobiliário
  '68': { cadeia: 'servicos', posicao: 'fim', clientes: [], fornecedores: ['41'] },
  // Profissionais
  '69': { cadeia: 'servicos', posicao: 'fim', clientes: ['10','41','46','62','64'], fornecedores: [] },
  '70': { cadeia: 'servicos', posicao: 'fim', clientes: ['10','41','46','62','64'], fornecedores: [] },
  '71': { cadeia: 'servicos', posicao: 'fim', clientes: ['41','42'], fornecedores: [] },
  '73': { cadeia: 'servicos', posicao: 'fim', clientes: ['10','47','62','64'], fornecedores: ['63'] },
  // Saúde
  '86': { cadeia: 'servicos', posicao: 'fim', clientes: [], fornecedores: ['21','26','46'] },
  // Educação
  '85': { cadeia: 'servicos', posicao: 'fim', clientes: [], fornecedores: ['62','18'] },
};

/**
 * Get the 2-digit CNAE division from a full CNAE code.
 * @param {string} cnae - Full CNAE code (e.g. "62.01-5-01" or "6201501")
 * @returns {string} 2-digit division
 */
function getCnaeDivision(cnae) {
  if (!cnae) return '';
  const digits = cnae.replace(/[^\d]/g, '');
  return digits.substring(0, 2);
}

/**
 * Determine sector from CNAE division.
 * @param {string} division - 2-digit CNAE division
 * @returns {string}
 */
function getSector(division) {
  if (CNAE_SECTOR_MAP[division]) return CNAE_SECTOR_MAP[division];
  const num = parseInt(division, 10);
  if (num >= 1 && num <= 3) return 'agro';
  if (num >= 5 && num <= 9) return 'mineracao';
  if (num >= 10 && num <= 33) return 'industria';
  if (num >= 41 && num <= 43) return 'construcao';
  if (num >= 45 && num <= 47) return 'comercio';
  return 'servicos';
}

/**
 * Build CNAE profile for a company.
 *
 * @param {string} empresaId - Company UUID
 * @returns {Promise<Object|null>} CNAE profile or null
 */
export async function buildCnaeProfile(empresaId) {
  const id = sanitizeUUID(empresaId);
  if (!id) return null;

  try {
    // Fetch company data
    const { data: empresa, error } = await supabase
      .from('dim_empresas')
      .select('id, cnae_principal, cnaes_secundarios, cidade, estado')
      .eq('id', id)
      .single();

    if (error || !empresa) {
      logger.warn('cnae_correlator_empresa_not_found', { empresaId: id });
      return null;
    }

    const division = getCnaeDivision(empresa.cnae_principal);
    if (!division) {
      logger.warn('cnae_correlator_no_cnae', { empresaId: id });
      return null;
    }

    const chainInfo = CNAE_CHAIN[division] || {
      cadeia: 'servicos',
      posicao: 'fim',
      clientes: [],
      fornecedores: [],
    };

    const sector = getSector(division);

    // Count companies with same CNAE in municipality
    const [municipalCount, estadualCount] = await Promise.all([
      countCompaniesByCnae(division, empresa.cidade, empresa.estado),
      countCompaniesByCnae(division, null, empresa.estado),
    ]);

    // Find competitors (same CNAE division, same region)
    const competitorDivisions = [division];

    // Build profile
    const profile = {
      empresa_id: id,
      cnae_principal: empresa.cnae_principal,
      cnae_descricao: null, // Will be filled by taxonomy
      cnaes_secundarios: empresa.cnaes_secundarios || [],
      setor_economico: sector,
      cadeia_valor: chainInfo.cadeia,
      posicao_cadeia: chainInfo.posicao,
      cnaes_clientes_tipicos: chainInfo.clientes,
      cnaes_fornecedores_tipicos: chainInfo.fornecedores,
      cnaes_concorrentes: competitorDivisions,
      total_empresas_mesmo_cnae_municipio: municipalCount,
      total_empresas_mesmo_cnae_estado: estadualCount,
      total_empresas_mesmo_cnae_brasil: null, // Expensive query, fill async
      ranking_municipal: null,
      ranking_estadual: null,
    };

    // Upsert profile
    const { data: saved, error: saveError } = await supabase
      .from('fato_perfil_cnae')
      .upsert(profile, { onConflict: 'empresa_id' })
      .select()
      .single();

    if (saveError) {
      // If upsert fails (no unique constraint yet), try insert
      const { data: inserted, error: insertError } = await supabase
        .from('fato_perfil_cnae')
        .insert(profile)
        .select()
        .single();

      if (insertError) {
        logger.error('cnae_profile_save_error', { empresaId: id, error: insertError.message });
        return null;
      }
      return inserted;
    }

    // Create evidence for CNAE correlations
    const evidences = [];

    for (const clientCnae of chainInfo.clientes) {
      evidences.push({
        entidade_origem_type: 'empresa',
        entidade_origem_id: id,
        tipo_evidencia: 'correlacao_cnae',
        fonte: 'cnae_correlacao',
        confianca: 0.6,
        metodo_extracao: 'rule_based',
        texto_evidencia: `CNAE ${division} tipicamente fornece para CNAE ${clientCnae}`,
        metadata: {
          cnae_origem: division,
          cnae_destino: clientCnae,
          relacao: 'cliente_tipico',
        },
      });
    }

    for (const supplierCnae of chainInfo.fornecedores) {
      evidences.push({
        entidade_origem_type: 'empresa',
        entidade_origem_id: id,
        tipo_evidencia: 'correlacao_cnae',
        fonte: 'cnae_correlacao',
        confianca: 0.6,
        metodo_extracao: 'rule_based',
        texto_evidencia: `CNAE ${division} tipicamente compra de CNAE ${supplierCnae}`,
        metadata: {
          cnae_origem: division,
          cnae_destino: supplierCnae,
          relacao: 'fornecedor_tipico',
        },
      });
    }

    if (evidences.length > 0) {
      // Fire and forget — don't block profile creation
      import('./evidence-manager.js').then((mod) =>
        mod.createEvidenceBatch(evidences)
      );
    }

    logger.info('cnae_profile_built', {
      empresaId: id,
      sector,
      cadeia: chainInfo.cadeia,
      posicao: chainInfo.posicao,
      clientes: chainInfo.clientes.length,
      fornecedores: chainInfo.fornecedores.length,
    });

    return saved;
  } catch (err) {
    logger.error('cnae_correlator_error', { empresaId: id, error: err.message });
    return null;
  }
}

/**
 * Count companies with matching CNAE division in a location.
 *
 * @param {string} division - 2-digit CNAE division
 * @param {string|null} cidade - City filter (null = skip)
 * @param {string|null} estado - State filter (null = skip)
 * @returns {Promise<number>}
 */
async function countCompaniesByCnae(division, cidade, estado) {
  let query = supabase
    .from('dim_empresas')
    .select('id', { count: 'exact', head: true })
    .ilike('cnae_principal', `${division}%`);

  if (cidade) query = query.eq('cidade', cidade);
  if (estado) query = query.eq('estado', estado);

  const { count, error } = await query;
  if (error) return 0;
  return count || 0;
}

/**
 * Find potential ecosystem relationships based on CNAE correlations.
 * Looks for companies whose CNAE matches the typical client/supplier pattern.
 *
 * @param {string} empresaId - Company UUID
 * @param {Object} [options={}]
 * @param {number} [options.limit=50] - Max results per type
 * @param {string} [options.estado] - Filter by state
 * @returns {Promise<Object>} { clientes: [], fornecedores: [], concorrentes: [] }
 */
export async function findCnaeRelationships(empresaId, options = {}) {
  const id = sanitizeUUID(empresaId);
  if (!id) return { clientes: [], fornecedores: [], concorrentes: [] };

  try {
    const { data: empresa } = await supabase
      .from('dim_empresas')
      .select('id, cnae_principal, cidade, estado')
      .eq('id', id)
      .single();

    if (!empresa?.cnae_principal) {
      return { clientes: [], fornecedores: [], concorrentes: [] };
    }

    const division = getCnaeDivision(empresa.cnae_principal);
    const chainInfo = CNAE_CHAIN[division] || { clientes: [], fornecedores: [] };
    const limit = Math.min(options.limit || 50, 200);

    const [clientes, fornecedores, concorrentes] = await Promise.all([
      // Potential clients: companies whose CNAE is in our typical client list
      findCompaniesByCnaeDivisions(chainInfo.clientes, empresa.estado, id, limit),
      // Potential suppliers: companies whose CNAE is in our typical supplier list
      findCompaniesByCnaeDivisions(chainInfo.fornecedores, empresa.estado, id, limit),
      // Competitors: same CNAE division, same state
      findCompaniesByCnaeDivisions([division], empresa.estado, id, limit),
    ]);

    return { clientes, fornecedores, concorrentes };
  } catch (err) {
    logger.error('cnae_find_relationships_error', { empresaId: id, error: err.message });
    return { clientes: [], fornecedores: [], concorrentes: [] };
  }
}

/**
 * Find companies by CNAE divisions.
 *
 * @param {string[]} divisions - 2-digit CNAE divisions
 * @param {string|null} estado - State filter
 * @param {string} excludeId - Exclude this company
 * @param {number} limit - Max results
 * @returns {Promise<Array>}
 */
async function findCompaniesByCnaeDivisions(divisions, estado, excludeId, limit) {
  if (!divisions?.length) return [];

  const orClauses = divisions.map((d) => `cnae_principal.ilike.${d}%`).join(',');

  let query = supabase
    .from('dim_empresas')
    .select('id, razao_social, nome_fantasia, cnae_principal, cidade, estado')
    .or(orClauses)
    .neq('id', excludeId);

  if (estado) {
    query = query.eq('estado', estado);
  }

  const { data, error } = await query.limit(limit);
  if (error) return [];
  return data || [];
}
