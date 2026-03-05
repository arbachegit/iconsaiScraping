/**
 * CNPJá API Integration
 * Provides Simples Nacional and MEI data with historical records
 */

const CNPJA_BASE_URL = 'https://api.cnpja.com';

function getApiKey() {
  return process.env.CNPJA_API_KEY;
}

/**
 * Fetch company tax regime from CNPJá
 * @param {string} cnpj - CNPJ (14 digits)
 * @returns {Promise<Object>} Tax regime data with history
 */
export async function getRegimeTributario(cnpj) {
  if (!getApiKey()) {
    console.warn('[CNPJA] API Key not configured');
    return null;
  }

  const cleanCnpj = cnpj.replace(/[^\d]/g, '');

  try {
    const response = await fetch(
      `${CNPJA_BASE_URL}/office/${cleanCnpj}?simples=true&simplesHistory=true`,
      {
        headers: {
          'Authorization': getApiKey()
        }
      }
    );

    if (!response.ok) {
      if (response.status === 401) {
        console.error('[CNPJA] Invalid API Key');
        return null;
      }
      if (response.status === 404) {
        console.warn(`[CNPJA] CNPJ not found: ${cleanCnpj}`);
        return null;
      }
      throw new Error(`CNPJá API error: ${response.status}`);
    }

    const data = await response.json();
    return transformCnpjaData(data);

  } catch (error) {
    console.error('[CNPJA] Error:', error.message);
    return null;
  }
}

/**
 * Transform CNPJá response to our format
 */
function transformCnpjaData(data) {
  const company = data.company || {};
  const simples = company.simples || {};
  const simei = company.simei || {};

  // Determine current regime
  let regimeAtual = 'LUCRO_PRESUMIDO'; // default
  if (simei.optant) {
    regimeAtual = 'MEI';
  } else if (simples.optant) {
    regimeAtual = 'SIMPLES_NACIONAL';
  }

  // Build history from simplesHistory
  const historico = [];

  // Current period
  if (simples.optant || simei.optant) {
    historico.push({
      regime: regimeAtual,
      data_inicio: simei.optant ? simei.since : simples.since,
      data_fim: null,
      ativo: true
    });
  }

  // Historical periods from simples
  if (simples.history && Array.isArray(simples.history)) {
    for (const period of simples.history) {
      historico.push({
        regime: 'SIMPLES_NACIONAL',
        data_inicio: period.since,
        data_fim: period.until,
        ativo: false,
        motivo_exclusao: period.reason || null
      });
    }
  }

  // Historical periods from MEI
  if (simei.history && Array.isArray(simei.history)) {
    for (const period of simei.history) {
      historico.push({
        regime: 'MEI',
        data_inicio: period.since,
        data_fim: period.until,
        ativo: false,
        motivo_exclusao: period.reason || null
      });
    }
  }

  // Sort by date (most recent first)
  historico.sort((a, b) => {
    const dateA = new Date(a.data_inicio || '1900-01-01');
    const dateB = new Date(b.data_inicio || '1900-01-01');
    return dateB - dateA;
  });

  // Infer if limit was exceeded
  const inferencias = inferirLimites(data, historico);

  return {
    cnpj: data.taxId,

    // Current regime
    regime_atual: regimeAtual,
    simples_optante: simples.optant || false,
    simples_desde: simples.since || null,
    mei_optante: simei.optant || false,
    mei_desde: simei.since || null,

    // Company size indicators
    porte: company.size?.acronym || null,
    porte_descricao: company.size?.text || null,
    capital_social: company.capital || null,
    natureza_juridica: company.nature?.text || null,

    // Activity
    cnae_principal: data.mainActivity?.id || null,
    cnae_descricao: data.mainActivity?.text || null,
    qtd_funcionarios: data.employees || null,

    // Historical data
    historico_regimes: historico,
    qtd_mudancas_regime: historico.filter(h => !h.ativo).length,

    // Inferences
    inferencias: inferencias,

    // Raw data
    raw_cnpja: data
  };
}

/**
 * Infer if company exceeded limits based on available data
 */
function inferirLimites(data, historico) {
  const inferencias = {
    provavelmente_ultrapassou_limite: false,
    sinais: [],
    confianca: 'baixa'
  };

  const company = data.company || {};
  const simples = company.simples || {};
  const simei = company.simei || {};

  // Signal 1: Changed from MEI to Simples
  const foiMei = historico.some(h => h.regime === 'MEI' && !h.ativo);
  const agoraSimples = simples.optant && !simei.optant;
  if (foiMei && agoraSimples) {
    inferencias.provavelmente_ultrapassou_limite = true;
    inferencias.sinais.push('Migrou de MEI para Simples Nacional (ultrapassou R$ 81.000/ano)');
    inferencias.confianca = 'alta';
  }

  // Signal 2: Excluded from Simples (exclusion reason often indicates limit)
  const excluidoSimples = historico.find(h =>
    h.regime === 'SIMPLES_NACIONAL' &&
    !h.ativo &&
    h.motivo_exclusao
  );
  if (excluidoSimples) {
    inferencias.provavelmente_ultrapassou_limite = true;
    inferencias.sinais.push(`Excluído do Simples: ${excluidoSimples.motivo_exclusao}`);
    inferencias.confianca = 'alta';
  }

  // Signal 3: Capital social high for MEI (limit is R$ 81k)
  if (simei.optant && company.capital > 50000) {
    inferencias.sinais.push('Capital social alto para MEI - pode estar próximo do limite');
    inferencias.confianca = 'media';
  }

  // Signal 4: Many employees for the regime
  const numFuncionarios = data.employees || 0;
  if (simei.optant && numFuncionarios > 1) {
    inferencias.provavelmente_ultrapassou_limite = true;
    inferencias.sinais.push(`MEI com ${numFuncionarios} funcionários (limite é 1)`);
    inferencias.confianca = 'alta';
  }
  if (simples.optant && numFuncionarios > 100) {
    inferencias.sinais.push(`${numFuncionarios} funcionários - empresa de porte significativo`);
    inferencias.confianca = 'media';
  }

  // Signal 5: Company age + regime (old MEI is suspicious)
  const dataAbertura = data.founded ? new Date(data.founded) : null;
  if (dataAbertura && simei.optant) {
    const anosOperando = (new Date() - dataAbertura) / (1000 * 60 * 60 * 24 * 365);
    if (anosOperando > 10) {
      inferencias.sinais.push(`MEI há ${Math.floor(anosOperando)} anos - pode ter faturamento próximo do limite`);
      inferencias.confianca = 'media';
    }
  }

  // Signal 6: Multiple regime changes
  if (historico.filter(h => !h.ativo).length >= 2) {
    inferencias.sinais.push('Múltiplas mudanças de regime tributário');
    inferencias.confianca = 'media';
  }

  return inferencias;
}

/**
 * Fetch full company data from CNPJá including QSA members
 * @param {string} cnpj - CNPJ (14 digits)
 * @returns {Promise<Object|null>} Company data with members, or null on failure
 */
export async function getCompanyFull(cnpj) {
  if (!getApiKey()) {
    console.warn('[CNPJA] API Key not configured');
    return null;
  }

  const cleanCnpj = cnpj.replace(/[^\d]/g, '');

  try {
    const response = await fetch(
      `${CNPJA_BASE_URL}/office/${cleanCnpj}?simples=true&members=true`,
      {
        headers: {
          'Authorization': getApiKey()
        }
      }
    );

    if (!response.ok) {
      if (response.status === 401) {
        console.error('[CNPJA] Invalid API Key');
        return null;
      }
      if (response.status === 404) {
        console.warn(`[CNPJA] CNPJ not found: ${cleanCnpj}`);
        return null;
      }
      throw new Error(`CNPJá API error: ${response.status}`);
    }

    const data = await response.json();
    return transformFullCompanyData(data);

  } catch (error) {
    console.error('[CNPJA] Error:', error.message);
    return null;
  }
}

/**
 * Transform CNPJá full company response for graph exploration
 */
function transformFullCompanyData(data) {
  const company = data.company || {};
  const address = data.address || {};
  const mainActivity = data.mainActivity || {};
  const members = company.members || [];

  return {
    cnpj: data.taxId,
    razao_social: company.name || null,
    nome_fantasia: data.alias || null,
    cidade: address.city || null,
    estado: address.state || null,
    cnae_principal: mainActivity.id || null,
    cnae_descricao: mainActivity.text || null,
    capital_social: company.capital || null,
    porte: company.size?.text || null,
    natureza_juridica: company.nature?.text || null,
    data_abertura: data.founded || null,
    situacao_cadastral: data.status?.text || null,
    socios: members.map(m => ({
      nome: m.person?.name || null,
      cpf_cnpj: m.person?.taxId || null,
      tipo: m.person?.type || null,
      cargo: m.role?.text || null,
      cargo_id: m.role?.id || null,
      desde: m.since || null,
    })).filter(s => s.nome),
    raw: data
  };
}

/**
 * Get MEI limit status
 */
export function getLimitesMei() {
  return {
    faturamento_anual: 81000,
    faturamento_mensal: 6750,
    funcionarios: 1,
    atividades_permitidas: 'Ver lista CNAE MEI'
  };
}

/**
 * Get Simples Nacional limits by revenue bracket
 */
export function getLimitesSimples() {
  return {
    ME: {
      faturamento_anual: 360000,
      descricao: 'Microempresa'
    },
    EPP: {
      faturamento_anual: 4800000,
      descricao: 'Empresa de Pequeno Porte'
    },
    faixas: [
      { de: 0, ate: 180000, aliquota_comercio: 4.0 },
      { de: 180000.01, ate: 360000, aliquota_comercio: 7.3 },
      { de: 360000.01, ate: 720000, aliquota_comercio: 9.5 },
      { de: 720000.01, ate: 1800000, aliquota_comercio: 10.7 },
      { de: 1800000.01, ate: 3600000, aliquota_comercio: 14.3 },
      { de: 3600000.01, ate: 4800000, aliquota_comercio: 19.0 }
    ]
  };
}