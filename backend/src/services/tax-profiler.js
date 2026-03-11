/**
 * Tax Profiler Service
 * Builds fiscal profile, estimates revenue, and classifies buyer persona.
 *
 * Uses existing data from dim_empresas + fato_regime_tributario.
 * No external API dependency.
 */

import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { sanitizeUUID } from '../utils/sanitize.js';
import {
  REGIME_TRIBUTARIO,
  LIMITES_REGIME,
  FATURAMENTO_POR_FUNCIONARIO,
  CNAE_SECTOR_MAP,
} from '../constants.js';

/**
 * Porte classification based on regime + capital social + employees.
 */
const PORTE_RULES = {
  MEI: 'MEI',
  SIMPLES_NACIONAL: null, // Determined by revenue estimate
  LUCRO_PRESUMIDO: 'MEDIO',
  LUCRO_REAL: 'GRANDE',
};

/**
 * Build tax/fiscal profile for a company.
 *
 * @param {string} empresaId - Company UUID
 * @returns {Promise<Object|null>} Tax profile or null
 */
export async function buildTaxProfile(empresaId) {
  const id = sanitizeUUID(empresaId);
  if (!id) return null;

  try {
    // Fetch company data
    const { data: empresa, error } = await supabase
      .from('dim_empresas')
      .select(
        'id, razao_social, cnae_principal, capital_social, data_abertura, qtd_socios, qtd_funcionarios'
      )
      .eq('id', id)
      .single();

    if (error || !empresa) {
      logger.warn('tax_profiler_empresa_not_found', { empresaId: id });
      return null;
    }

    // Fetch latest regime tributário
    const { data: regimeData } = await supabase
      .from('fato_regime_tributario')
      .select('regime, data_opcao')
      .eq('empresa_id', id)
      .order('data_opcao', { ascending: false })
      .limit(1);

    const regime = regimeData?.[0]?.regime || REGIME_TRIBUTARIO.DESCONHECIDO;

    // Calculate age
    const idadeAnos = empresa.data_abertura
      ? Math.floor(
          (Date.now() - new Date(empresa.data_abertura).getTime()) /
            (365.25 * 24 * 60 * 60 * 1000)
        )
      : null;

    // Estimate revenue
    const { min: fatMin, max: fatMax } = estimateRevenue(
      regime,
      empresa.capital_social,
      empresa.qtd_funcionarios,
      empresa.cnae_principal
    );

    // Determine porte
    const porte = classifyPorte(regime, fatMax, empresa.capital_social);

    // Estimate employees if not available
    const funcionarios =
      empresa.qtd_funcionarios || estimateEmployees(regime, fatMax);

    // Fiscal health score (0-1)
    const scoreSaude = calculateFiscalHealth(
      regime,
      idadeAnos,
      empresa.capital_social,
      empresa.qtd_socios
    );

    // Buyer persona
    const perfilComprador = classifyBuyerPersona(porte, regime, fatMax);

    // Purchasing power
    const poderCompra = classifyPurchasingPower(fatMax);

    const profile = {
      empresa_id: id,
      regime_tributario: regime,
      porte,
      faturamento_estimado_min: fatMin,
      faturamento_estimado_max: fatMax,
      capital_social: empresa.capital_social,
      idade_empresa_anos: idadeAnos,
      quantidade_socios: empresa.qtd_socios,
      quantidade_funcionarios_estimado: funcionarios,
      score_saude_fiscal: scoreSaude,
      perfil_comprador: perfilComprador,
      poder_compra_estimado: poderCompra,
    };

    // Upsert
    const { data: existing } = await supabase
      .from('fato_perfil_tributario')
      .select('id')
      .eq('empresa_id', id)
      .limit(1);

    let saved;
    if (existing?.length > 0) {
      const { data, error: upErr } = await supabase
        .from('fato_perfil_tributario')
        .update({ ...profile, updated_at: new Date().toISOString() })
        .eq('empresa_id', id)
        .select()
        .single();
      if (upErr) throw upErr;
      saved = data;
    } else {
      const { data, error: insErr } = await supabase
        .from('fato_perfil_tributario')
        .insert(profile)
        .select()
        .single();
      if (insErr) throw insErr;
      saved = data;
    }

    logger.info('tax_profile_built', {
      empresaId: id,
      regime,
      porte,
      fatMin,
      fatMax,
      scoreSaude,
      perfilComprador,
    });

    return saved;
  } catch (err) {
    logger.error('tax_profiler_error', { empresaId: id, error: err.message });
    return null;
  }
}

/**
 * Estimate annual revenue based on regime, capital, employees, and sector.
 *
 * @param {string} regime
 * @param {number|null} capitalSocial
 * @param {number|null} qtdFuncionarios
 * @param {string|null} cnaePrincipal
 * @returns {{ min: number, max: number }}
 */
function estimateRevenue(regime, capitalSocial, qtdFuncionarios, cnaePrincipal) {
  // Base ranges by regime
  const ranges = {
    [REGIME_TRIBUTARIO.MEI]: { min: 0, max: LIMITES_REGIME.MEI },
    [REGIME_TRIBUTARIO.SIMPLES_NACIONAL]: {
      min: LIMITES_REGIME.MEI,
      max: LIMITES_REGIME.SIMPLES_EPP,
    },
    [REGIME_TRIBUTARIO.LUCRO_PRESUMIDO]: {
      min: LIMITES_REGIME.SIMPLES_EPP,
      max: LIMITES_REGIME.LUCRO_PRESUMIDO,
    },
    [REGIME_TRIBUTARIO.LUCRO_REAL]: {
      min: LIMITES_REGIME.LUCRO_PRESUMIDO,
      max: LIMITES_REGIME.LUCRO_PRESUMIDO * 10,
    },
  };

  const base = ranges[regime] || { min: 0, max: LIMITES_REGIME.SIMPLES_EPP };

  // Refine with employee count
  if (qtdFuncionarios && qtdFuncionarios > 0) {
    const division = cnaePrincipal
      ? cnaePrincipal.replace(/[^\d]/g, '').substring(0, 2)
      : '';
    const sector = CNAE_SECTOR_MAP[division] || 'default';
    const perEmployee = FATURAMENTO_POR_FUNCIONARIO[sector] || FATURAMENTO_POR_FUNCIONARIO.default;
    const employeeEstimate = qtdFuncionarios * perEmployee;

    return {
      min: Math.max(base.min, employeeEstimate * 0.7),
      max: Math.min(base.max, employeeEstimate * 1.5),
    };
  }

  // Refine with capital social
  if (capitalSocial && capitalSocial > 0) {
    // Rule of thumb: revenue ~ 3-10x capital social
    const capMin = capitalSocial * 3;
    const capMax = capitalSocial * 10;

    return {
      min: Math.max(base.min, capMin),
      max: Math.min(base.max, capMax),
    };
  }

  return base;
}

/**
 * Classify company porte (size).
 */
function classifyPorte(regime, fatMax, capitalSocial) {
  if (regime === REGIME_TRIBUTARIO.MEI) return 'MEI';
  if (regime === REGIME_TRIBUTARIO.LUCRO_REAL) return 'GRANDE';
  if (regime === REGIME_TRIBUTARIO.LUCRO_PRESUMIDO) return 'MEDIO';

  if (fatMax <= LIMITES_REGIME.SIMPLES_ME) return 'ME';
  if (fatMax <= LIMITES_REGIME.SIMPLES_EPP) return 'EPP';

  if (capitalSocial && capitalSocial > 1000000) return 'MEDIO';

  return 'ME';
}

/**
 * Estimate employee count from regime and revenue.
 */
function estimateEmployees(regime, fatMax) {
  if (regime === REGIME_TRIBUTARIO.MEI) return 1;
  if (!fatMax) return null;

  const avgRevPerEmployee = FATURAMENTO_POR_FUNCIONARIO.default;
  return Math.max(1, Math.round(fatMax / avgRevPerEmployee));
}

/**
 * Calculate fiscal health score (0-1).
 * Higher = healthier.
 */
function calculateFiscalHealth(regime, idadeAnos, capitalSocial, qtdSocios) {
  let score = 0.5; // Base

  // Regime maturity
  if (regime === REGIME_TRIBUTARIO.LUCRO_REAL) score += 0.15;
  else if (regime === REGIME_TRIBUTARIO.LUCRO_PRESUMIDO) score += 0.10;
  else if (regime === REGIME_TRIBUTARIO.SIMPLES_NACIONAL) score += 0.05;
  else if (regime === REGIME_TRIBUTARIO.MEI) score -= 0.05;

  // Age bonus
  if (idadeAnos !== null) {
    if (idadeAnos >= 10) score += 0.15;
    else if (idadeAnos >= 5) score += 0.10;
    else if (idadeAnos >= 2) score += 0.05;
    else score -= 0.10; // Very young company
  }

  // Capital social
  if (capitalSocial) {
    if (capitalSocial >= 1000000) score += 0.10;
    else if (capitalSocial >= 100000) score += 0.05;
  }

  // Multiple partners = governance
  if (qtdSocios && qtdSocios >= 2) score += 0.05;

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

/**
 * Classify buyer persona based on porte and regime.
 */
function classifyBuyerPersona(porte, regime, fatMax) {
  if (porte === 'MEI' || porte === 'ME') return 'price_sensitive';
  if (porte === 'GRANDE' || regime === REGIME_TRIBUTARIO.LUCRO_REAL) return 'premium';
  if (fatMax && fatMax > LIMITES_REGIME.SIMPLES_EPP) return 'value_oriented';
  return 'value_oriented';
}

/**
 * Classify purchasing power.
 */
function classifyPurchasingPower(fatMax) {
  if (!fatMax) return 'medio';
  if (fatMax >= LIMITES_REGIME.LUCRO_PRESUMIDO) return 'muito_alto';
  if (fatMax >= LIMITES_REGIME.SIMPLES_EPP) return 'alto';
  if (fatMax >= LIMITES_REGIME.SIMPLES_ME) return 'medio';
  return 'baixo';
}
