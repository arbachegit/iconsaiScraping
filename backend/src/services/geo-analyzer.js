/**
 * Geographic Analyzer Service
 * Builds geographic profile for companies: arc of operation, competitor density,
 * market saturation, and expansion opportunities.
 *
 * Uses existing data from dim_empresas + Brasil Data Hub (geo_municipios).
 */

import { supabase } from '../database/supabase.js';
import { createClient } from '@supabase/supabase-js';
import logger from '../utils/logger.js';
import { sanitizeUUID } from '../utils/sanitize.js';
import { createEvidence } from './evidence-manager.js';
import { EVIDENCE_TYPES, EVIDENCE_SOURCES, ARCO_ATUACAO } from '../constants.js';

const brasilDataHub =
  process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
    ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
    : null;

/**
 * Build geographic profile for a company.
 *
 * @param {string} empresaId - Company UUID
 * @returns {Promise<Object|null>} Geographic profile or null
 */
export async function buildGeoProfile(empresaId) {
  const id = sanitizeUUID(empresaId);
  if (!id) return null;

  try {
    // Fetch company data
    const { data: empresa, error } = await supabase
      .from('dim_empresas')
      .select('id, razao_social, cnae_principal, cidade, estado, cep')
      .eq('id', id)
      .single();

    if (error || !empresa) {
      logger.warn('geo_analyzer_empresa_not_found', { empresaId: id });
      return null;
    }

    if (!empresa.cidade || !empresa.estado) {
      logger.warn('geo_analyzer_no_location', { empresaId: id });
      return null;
    }

    // Get CNAE division for competitor search
    const cnaeDivision = empresa.cnae_principal
      ? empresa.cnae_principal.replace(/[^\d]/g, '').substring(0, 2)
      : null;

    // Parallel: competitor counts + municipality data
    const [
      competitorsLocal,
      competitorsState,
      municipioData,
      stateCompanies,
    ] = await Promise.all([
      countCompetitors(cnaeDivision, empresa.cidade, empresa.estado),
      countCompetitors(cnaeDivision, null, empresa.estado),
      getMunicipioData(empresa.cidade, empresa.estado),
      getStateDistribution(cnaeDivision, empresa.estado),
    ]);

    // Determine arc of operation
    const arco = determineArc(empresa, competitorsLocal, competitorsState);

    // Calculate saturation index
    const saturation = calculateSaturation(
      competitorsLocal,
      municipioData?.populacao
    );

    // Find geographic opportunities (cities with low saturation)
    const opportunities = await findGeoOpportunities(
      cnaeDivision,
      empresa.estado,
      empresa.cidade
    );

    const profile = {
      empresa_id: id,
      arco_atuacao: arco,
      municipios_atuacao: [empresa.cidade],
      estados_atuacao: [empresa.estado],
      raio_km: arco === ARCO_ATUACAO.LOCAL ? 50 : arco === ARCO_ATUACAO.MUNICIPAL ? 100 : null,
      densidade_concorrentes: competitorsLocal,
      market_share_estimado: competitorsLocal > 0 ? Math.round((1 / competitorsLocal) * 10000) / 100 : null,
      populacao_alcancavel: municipioData?.populacao || null,
      pib_regional: municipioData?.pib || null,
      indice_saturacao: saturation,
      oportunidades_geograficas: opportunities,
    };

    // Upsert
    const { data: existing } = await supabase
      .from('fato_perfil_geografico')
      .select('id')
      .eq('empresa_id', id)
      .limit(1);

    let saved;
    if (existing?.length > 0) {
      const { data, error: upErr } = await supabase
        .from('fato_perfil_geografico')
        .update({ ...profile, updated_at: new Date().toISOString() })
        .eq('empresa_id', id)
        .select()
        .single();
      if (upErr) throw upErr;
      saved = data;
    } else {
      const { data, error: insErr } = await supabase
        .from('fato_perfil_geografico')
        .insert(profile)
        .select()
        .single();
      if (insErr) throw insErr;
      saved = data;
    }

    // Create geographic evidence
    if (opportunities?.cidades_oportunidade?.length > 0) {
      await createEvidence({
        entidade_origem_type: 'empresa',
        entidade_origem_id: id,
        tipo_evidencia: EVIDENCE_TYPES.PROXIMIDADE_GEO,
        fonte: EVIDENCE_SOURCES.GEO_ANALISE,
        confianca: 0.6,
        metodo_extracao: 'statistical',
        texto_evidencia: `${opportunities.cidades_oportunidade.length} cidades com oportunidade de expansão no estado ${empresa.estado}`,
        metadata: { oportunidades: opportunities },
      });
    }

    logger.info('geo_profile_built', {
      empresaId: id,
      arco,
      concorrentes: competitorsLocal,
      saturacao: saturation,
      oportunidades: opportunities?.cidades_oportunidade?.length || 0,
    });

    return saved;
  } catch (err) {
    logger.error('geo_analyzer_error', { empresaId: id, error: err.message });
    return null;
  }
}

/**
 * Determine the geographic arc of operation.
 */
function determineArc(empresa, localCompetitors, stateCompetitors) {
  // Simple heuristic based on available data
  // More accurate with website crawl data (shipping areas, branch locations)
  if (localCompetitors <= 5) return ARCO_ATUACAO.LOCAL;
  if (localCompetitors <= 20) return ARCO_ATUACAO.MUNICIPAL;
  if (stateCompetitors > localCompetitors * 5) return ARCO_ATUACAO.ESTADUAL;
  return ARCO_ATUACAO.MUNICIPAL;
}

/**
 * Calculate market saturation index (0-1).
 * 0 = empty market, 1 = saturated
 */
function calculateSaturation(competitors, populacao) {
  if (!competitors || !populacao) return null;

  // Companies per 10k inhabitants
  const ratio = (competitors / populacao) * 10000;

  // Normalize: 0-5 per 10k = low, 5-20 = medium, 20+ = saturated
  if (ratio < 1) return 0.1;
  if (ratio < 5) return 0.3;
  if (ratio < 10) return 0.5;
  if (ratio < 20) return 0.7;
  return 0.9;
}

/**
 * Count competitors (same CNAE division) in a location.
 */
async function countCompetitors(cnaeDivision, cidade, estado) {
  if (!cnaeDivision) return 0;

  let query = supabase
    .from('dim_empresas')
    .select('id', { count: 'exact', head: true })
    .ilike('cnae_principal', `${cnaeDivision}%`);

  if (cidade) query = query.eq('cidade', cidade);
  if (estado) query = query.eq('estado', estado);

  const { count, error } = await query;
  if (error) return 0;
  return count || 0;
}

/**
 * Get municipality data from Brasil Data Hub.
 */
async function getMunicipioData(cidade, estado) {
  if (!brasilDataHub) return null;

  try {
    const { data, error } = await brasilDataHub
      .from('geo_municipios')
      .select('populacao, pib, area_km2, codigo_ibge')
      .eq('nome', cidade)
      .eq('uf', estado)
      .limit(1);

    if (error || !data?.length) return null;
    return data[0];
  } catch {
    return null;
  }
}

/**
 * Get company distribution by city in a state for a CNAE division.
 */
async function getStateDistribution(cnaeDivision, estado) {
  if (!cnaeDivision || !estado) return [];

  const { data, error } = await supabase
    .rpc('count_empresas_by_cidade', {
      p_cnae_prefix: cnaeDivision,
      p_estado: estado,
    })
    .limit(50);

  // If RPC doesn't exist, fallback silently
  if (error) return [];
  return data || [];
}

/**
 * Find cities with expansion opportunities (low competitor density).
 */
async function findGeoOpportunities(cnaeDivision, estado, currentCidade) {
  if (!cnaeDivision || !estado) return null;

  // Get cities in the state with companies but few in this CNAE
  // This is a simplified heuristic — full version would use population data
  const { data: allCities, error } = await supabase
    .from('dim_empresas')
    .select('cidade')
    .eq('estado', estado)
    .not('cidade', 'is', null);

  if (error || !allCities?.length) return null;

  // Count unique cities
  const cityCount = {};
  for (const row of allCities) {
    cityCount[row.cidade] = (cityCount[row.cidade] || 0) + 1;
  }

  // Count competitors per city
  const { data: competitors } = await supabase
    .from('dim_empresas')
    .select('cidade')
    .eq('estado', estado)
    .ilike('cnae_principal', `${cnaeDivision}%`)
    .not('cidade', 'is', null);

  const competitorCount = {};
  for (const row of (competitors || [])) {
    competitorCount[row.cidade] = (competitorCount[row.cidade] || 0) + 1;
  }

  // Find cities with many companies overall but few competitors
  const opportunities = Object.entries(cityCount)
    .filter(([city]) => city !== currentCidade)
    .map(([city, total]) => ({
      cidade: city,
      total_empresas: total,
      concorrentes_cnae: competitorCount[city] || 0,
      ratio: total > 0 ? (competitorCount[city] || 0) / total : 0,
    }))
    .filter((c) => c.total_empresas >= 10 && c.ratio < 0.05) // Few competitors relative to total
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 10);

  return {
    cidades_oportunidade: opportunities,
    estado,
    total_cidades_analisadas: Object.keys(cityCount).length,
  };
}
