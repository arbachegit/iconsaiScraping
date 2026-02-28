/**
 * Search Orchestrator Service
 *
 * Provides realistic search results for people and companies with:
 * - Query analysis (type, strength, extracted/missing fields, strategy)
 * - Cardinality estimation (DB count + heuristics)
 * - Refinement suggestions for weak queries
 * - Result ranking by relevance
 * - Evidence logging
 *
 * @module search-orchestrator
 */

import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';

// ============================================
// COMMON BRAZILIAN NAME/COMPANY HEURISTICS
// ============================================

const COMMON_FIRST_NAMES = new Set([
  'joao', 'maria', 'jose', 'ana', 'pedro', 'paulo', 'carlos', 'francisco',
  'antonio', 'lucas', 'marcos', 'rafael', 'gabriel', 'bruno', 'daniel',
  'fernando', 'felipe', 'rodrigo', 'anderson', 'andre', 'diego', 'thiago',
  'leandro', 'marcelo', 'ricardo', 'eduardo', 'gustavo', 'henrique', 'matheus',
  'patricia', 'juliana', 'camila', 'fernanda', 'aline', 'bruna', 'jessica',
  'amanda', 'larissa', 'leticia', 'vanessa', 'adriana', 'renata', 'tatiana'
]);

const COMMON_SURNAMES = new Set([
  'silva', 'santos', 'souza', 'oliveira', 'pereira', 'costa', 'rodrigues',
  'almeida', 'nascimento', 'lima', 'araujo', 'fernandes', 'carvalho', 'gomes',
  'martins', 'rocha', 'ribeiro', 'alves', 'monteiro', 'mendes', 'barros'
]);

// Generic company terms that make queries weak
const GENERIC_COMPANY_TERMS = new Set([
  'comercio', 'servicos', 'tecnologia', 'consultoria', 'assessoria',
  'industria', 'distribuidora', 'construtora', 'transportes', 'logistica',
  'alimentos', 'empreendimentos', 'participacoes', 'gestao', 'solucoes',
  'digital', 'brasil', 'group', 'holding', 'ltda', 'sa', 'eireli', 'me', 'epp'
]);

// CNPJ regex
const CNPJ_REGEX = /^\d{14}$/;
const CPF_REGEX = /^\d{11}$/;

// ============================================
// QUERY ANALYSIS
// ============================================

/**
 * Analyze a search query to determine type, strength, and strategy.
 *
 * @param {Object} input - Search input
 * @param {string} [input.nome] - Name (person or company)
 * @param {string} [input.cpf] - CPF (person)
 * @param {string} [input.cnpj] - CNPJ (company)
 * @param {string} [input.cidade] - City
 * @param {string} [input.segmento] - Business segment
 * @param {string} [input.regime] - Tax regime
 * @param {string} [input.dataNascimento] - Date of birth
 * @param {string} [input.cidadeUf] - City/UF (person)
 * @param {'person'|'company'} [input.entityType] - Explicit entity type
 * @returns {{ type: 'person'|'company', strength: 'weak'|'medium'|'strong', extractedFields: Object, missingFields: string[], strategy: 'direct'|'refine'|'federated'|'blocked', reason: string }}
 */
export function analyzeQuery(input) {
  const { nome, cpf, cnpj, cidade, segmento, regime, dataNascimento, cidadeUf, entityType } = input;

  // Determine type
  const type = entityType || (cpf || dataNascimento || cidadeUf ? 'person' : 'company');

  const extractedFields = {};
  const missingFields = [];

  if (type === 'person') {
    return analyzePersonQuery({ nome, cpf, dataNascimento, cidadeUf, extractedFields, missingFields });
  }
  return analyzeCompanyQuery({ nome, cnpj, cidade, segmento, regime, extractedFields, missingFields });
}

/**
 * Analyze a person search query
 */
function analyzePersonQuery({ nome, cpf, dataNascimento, cidadeUf, extractedFields, missingFields }) {
  // CPF → strong
  if (cpf && CPF_REGEX.test(cpf)) {
    extractedFields.cpf = cpf;
    return {
      type: 'person',
      strength: 'strong',
      extractedFields,
      missingFields: [],
      strategy: 'direct',
      reason: 'CPF fornecido — busca direta'
    };
  }

  if (!nome || nome.trim().length < 2) {
    return {
      type: 'person',
      strength: 'weak',
      extractedFields,
      missingFields: ['nome'],
      strategy: 'blocked',
      reason: 'Nome é obrigatório (mínimo 2 caracteres)'
    };
  }

  const normalized = nome.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = normalized.split(/\s+/).filter(t => t.length >= 2);
  extractedFields.nome = nome.trim();
  if (dataNascimento) extractedFields.dataNascimento = dataNascimento;
  if (cidadeUf) extractedFields.cidadeUf = cidadeUf;

  const allCommon = tokens.every(t => COMMON_FIRST_NAMES.has(t) || COMMON_SURNAMES.has(t));
  const hasAuxiliary = !!(dataNascimento || cidadeUf);

  // 3+ tokens → medium or strong
  if (tokens.length >= 3) {
    if (hasAuxiliary) {
      return {
        type: 'person',
        strength: 'strong',
        extractedFields,
        missingFields: [],
        strategy: 'direct',
        reason: 'Nome completo com dados auxiliares'
      };
    }
    return {
      type: 'person',
      strength: 'medium',
      extractedFields,
      missingFields: allCommon ? ['cidadeUf', 'dataNascimento'] : [],
      strategy: 'federated',
      reason: allCommon
        ? 'Nome completo mas muito comum — recomenda-se adicionar cidade/UF'
        : 'Nome completo — busca federada'
    };
  }

  // 2 tokens
  if (tokens.length >= 2) {
    if (!allCommon && hasAuxiliary) {
      return {
        type: 'person',
        strength: 'medium',
        extractedFields,
        missingFields: [],
        strategy: 'federated',
        reason: 'Nome + sobrenome com dados auxiliares'
      };
    }
    if (allCommon && !hasAuxiliary) {
      missingFields.push('cidadeUf', 'dataNascimento');
      return {
        type: 'person',
        strength: 'weak',
        extractedFields,
        missingFields,
        strategy: 'refine',
        reason: `"${nome.trim()}" é muito comum no Brasil. Adicione cidade/UF ou data de nascimento.`
      };
    }
    return {
      type: 'person',
      strength: 'medium',
      extractedFields,
      missingFields: [],
      strategy: 'federated',
      reason: 'Nome + sobrenome — busca federada'
    };
  }

  // 1 token → weak
  missingFields.push('nome');
  if (!hasAuxiliary) missingFields.push('cidadeUf', 'dataNascimento');
  return {
    type: 'person',
    strength: 'weak',
    extractedFields,
    missingFields,
    strategy: 'refine',
    reason: 'Nome com apenas 1 palavra. Informe nome completo (nome e sobrenome).'
  };
}

/**
 * Analyze a company search query
 */
function analyzeCompanyQuery({ nome, cnpj, cidade, segmento, regime, extractedFields, missingFields }) {
  // CNPJ → strong
  if (cnpj && CNPJ_REGEX.test(cnpj.replace(/[^\d]/g, ''))) {
    extractedFields.cnpj = cnpj.replace(/[^\d]/g, '');
    return {
      type: 'company',
      strength: 'strong',
      extractedFields,
      missingFields: [],
      strategy: 'direct',
      reason: 'CNPJ fornecido — busca direta'
    };
  }

  if (!nome || nome.trim().length < 2) {
    return {
      type: 'company',
      strength: 'weak',
      extractedFields,
      missingFields: ['nome'],
      strategy: 'blocked',
      reason: 'Nome da empresa é obrigatório (mínimo 2 caracteres)'
    };
  }

  const normalized = nome.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = normalized.split(/\s+/).filter(t => t.length >= 2);
  extractedFields.nome = nome.trim();
  if (cidade) extractedFields.cidade = cidade;
  if (segmento) extractedFields.segmento = segmento;
  if (regime) extractedFields.regime = regime;

  const significantTokens = tokens.filter(t => !GENERIC_COMPANY_TERMS.has(t));
  const filledFilters = [cidade, segmento, regime].filter(Boolean).length;

  // Strong: specific name + city or multiple filters
  if (significantTokens.length >= 2 && filledFilters >= 1) {
    return {
      type: 'company',
      strength: 'strong',
      extractedFields,
      missingFields: [],
      strategy: 'direct',
      reason: 'Nome específico com filtros adicionais'
    };
  }

  // Medium: specific name alone, or generic name + city
  if (significantTokens.length >= 2 || (significantTokens.length >= 1 && filledFilters >= 1)) {
    return {
      type: 'company',
      strength: 'medium',
      extractedFields,
      missingFields: cidade ? [] : ['cidade'],
      strategy: 'federated',
      reason: cidade
        ? 'Nome + cidade — busca federada'
        : 'Nome específico — recomenda-se adicionar cidade'
    };
  }

  // Weak: all generic tokens, no filters
  if (significantTokens.length === 0) {
    missingFields.push('nome');
    if (!cidade) missingFields.push('cidade');
    return {
      type: 'company',
      strength: 'weak',
      extractedFields,
      missingFields,
      strategy: 'refine',
      reason: `"${nome.trim()}" é um termo genérico. Adicione nome fantasia específico ou cidade.`
    };
  }

  // 1 significant token, no filters → medium (allow federated search)
  if (!cidade) missingFields.push('cidade');
  return {
    type: 'company',
    strength: 'medium',
    extractedFields,
    missingFields,
    strategy: 'federated',
    reason: `"${nome.trim()}" — busca federada. Adicione cidade para resultados mais precisos.`
  };
}

// ============================================
// CARDINALITY ESTIMATION
// ============================================

/**
 * Estimate how many matches a query would return.
 * Uses DB COUNT + heuristics.
 *
 * @param {Object} query - The analyzed query
 * @param {string} query.type - 'person' or 'company'
 * @param {Object} query.extractedFields - Fields extracted from input
 * @returns {Promise<{ estimatedMatches: number, dbCount: number, source: 'db'|'heuristic', confidence: number }>}
 */
export async function estimateCardinality(query) {
  const { type, extractedFields } = query;

  try {
    if (type === 'person') {
      return await estimatePersonCardinality(extractedFields);
    }
    return await estimateCompanyCardinality(extractedFields);
  } catch (err) {
    logger.warn('Cardinality estimation failed, using heuristic', { error: err.message });
    return {
      estimatedMatches: type === 'person' ? 1000 : 500,
      dbCount: 0,
      source: 'heuristic',
      confidence: 0.1
    };
  }
}

/**
 * Estimate person cardinality
 */
async function estimatePersonCardinality(fields) {
  const { cpf, nome } = fields;

  // CPF → at most 1
  if (cpf) {
    const { count } = await supabase
      .from('fato_pessoas')
      .select('id', { count: 'exact', head: true })
      .eq('cpf', cpf);
    return {
      estimatedMatches: count || 0,
      dbCount: count || 0,
      source: 'db',
      confidence: 0.95
    };
  }

  // Nome → count in DB + heuristic for external
  if (nome) {
    const searchName = nome.trim();
    const escapedName = escapeLike(searchName);
    const { count } = await supabase
      .from('fato_pessoas')
      .select('id', { count: 'exact', head: true })
      .or(`nome_completo.ilike.%${escapedName}%,primeiro_nome.ilike.%${escapedName}%`);

    const dbCount = count || 0;
    const normalized = searchName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const tokens = normalized.split(/\s+/).filter(t => t.length >= 2);
    const allCommon = tokens.every(t => COMMON_FIRST_NAMES.has(t) || COMMON_SURNAMES.has(t));

    // Heuristic: common names in Brazil → millions of matches externally
    let externalEstimate = 0;
    if (tokens.length === 1 && COMMON_FIRST_NAMES.has(tokens[0])) {
      externalEstimate = 5_000_000;
    } else if (tokens.length === 2 && allCommon) {
      externalEstimate = 50_000;
    } else if (tokens.length === 2) {
      externalEstimate = 5_000;
    } else if (tokens.length >= 3 && allCommon) {
      externalEstimate = 1_000;
    } else if (tokens.length >= 3) {
      externalEstimate = 100;
    }

    return {
      estimatedMatches: dbCount + externalEstimate,
      dbCount,
      externalEstimate,
      source: externalEstimate > 0 ? 'heuristic' : 'db',
      confidence: externalEstimate > 0 ? 0.3 : 0.8
    };
  }

  return { estimatedMatches: 0, dbCount: 0, source: 'db', confidence: 1.0 };
}

/**
 * Estimate company cardinality
 */
async function estimateCompanyCardinality(fields) {
  const { cnpj, nome, cidade } = fields;

  // CNPJ → at most 1
  if (cnpj) {
    const { count } = await supabase
      .from('dim_empresas')
      .select('id', { count: 'exact', head: true })
      .eq('cnpj', cnpj);
    return {
      estimatedMatches: count || 0,
      dbCount: count || 0,
      source: 'db',
      confidence: 0.95
    };
  }

  // Nome + optional cidade → count in DB + heuristic
  if (nome) {
    const searchName = nome.trim();
    const escapedName = escapeLike(searchName);
    let query = supabase
      .from('dim_empresas')
      .select('id', { count: 'exact', head: true })
      .or(`razao_social.ilike.%${escapedName}%,nome_fantasia.ilike.%${escapedName}%`);

    if (cidade) {
      query = query.ilike('cidade', `%${escapeLike(cidade)}%`);
    }

    const { count } = await query;
    const dbCount = count || 0;

    // Heuristic for external (Google returns max ~20 CNPJs per search)
    const normalized = searchName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const tokens = normalized.split(/\s+/).filter(t => t.length >= 2);
    const significantTokens = tokens.filter(t => !GENERIC_COMPANY_TERMS.has(t));

    let externalEstimate = 0;
    if (significantTokens.length === 0) {
      externalEstimate = 100_000; // "comercio" alone → massive
    } else if (significantTokens.length === 1 && !cidade) {
      externalEstimate = 5_000;
    } else if (significantTokens.length === 1 && cidade) {
      externalEstimate = 500;
    } else {
      externalEstimate = 100;
    }

    return {
      estimatedMatches: dbCount + externalEstimate,
      dbCount,
      externalEstimate,
      source: externalEstimate > 0 ? 'heuristic' : 'db',
      confidence: externalEstimate > 0 ? 0.3 : 0.8
    };
  }

  return { estimatedMatches: 0, dbCount: 0, source: 'db', confidence: 1.0 };
}

// ============================================
// RESULT RANKING
// ============================================

/**
 * Rank results by relevance.
 *
 * Order:
 * 1. Exact match (name/CNPJ/CPF)
 * 2. Source reliability (db > brasilapi > apollo > serper > perplexity)
 * 3. Data completeness (more fields filled → higher rank)
 * 4. Recency (newer records first)
 *
 * @param {Array} results - Array of result objects
 * @param {string} queryText - Original search text for matching
 * @returns {Array} Sorted results with _relevanceScore
 */
export function rankResults(results, queryText) {
  if (!results || results.length === 0) return [];

  const queryNorm = (queryText || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const SOURCE_WEIGHTS = {
    'db': 1.0,
    'interno': 1.0,
    'brasilapi': 0.9,
    'apollo': 0.8,
    'serper': 0.6,
    'perplexity': 0.5,
    'external': 0.4,
    'externo': 0.4,
    'serper_exact': 0.3
  };

  return results.map(r => {
    let score = 0;

    // 1. Exact match bonus (0-40 points)
    const nameFields = [r.razao_social, r.nome_fantasia, r.nome_completo, r.nome].filter(Boolean);
    for (const field of nameFields) {
      const fieldNorm = field.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (fieldNorm === queryNorm) {
        score += 40; // Exact match
        break;
      } else if (fieldNorm.startsWith(queryNorm) || queryNorm.startsWith(fieldNorm)) {
        score += 25; // Prefix match
        break;
      } else if (fieldNorm.includes(queryNorm)) {
        score += 15; // Contains match
        break;
      }
    }

    // 2. Source reliability (0-30 points)
    const source = r._source || r.fonte || 'external';
    score += (SOURCE_WEIGHTS[source] || 0.3) * 30;

    // 3. Data completeness (0-20 points)
    const allFields = Object.values(r).filter(v => v != null && v !== '' && v !== 'NAO_POSSUI');
    const completeness = Math.min(allFields.length / 15, 1.0);
    score += completeness * 20;

    // 4. Recency (0-10 points)
    if (r.created_at) {
      const ageMs = Date.now() - new Date(r.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      score += Math.max(0, 10 - (ageDays / 365) * 10);
    }

    return { ...r, _relevanceScore: Math.round(score * 10) / 10 };
  }).sort((a, b) => b._relevanceScore - a._relevanceScore);
}

// ============================================
// REFINEMENT SUGGESTIONS
// ============================================

/**
 * Build refinement suggestions based on query analysis.
 *
 * @param {Object} analysis - Result from analyzeQuery
 * @param {Object} cardinality - Result from estimateCardinality
 * @returns {{ status: 'REFINE_REQUIRED'|'OK', message: string, suggestions: string[], estimatedMatches: number }}
 */
export function buildRefinementResponse(analysis, cardinality) {
  if (analysis.strategy === 'blocked') {
    return {
      status: 'REFINE_REQUIRED',
      message: analysis.reason,
      suggestions: analysis.missingFields.map(f => FIELD_SUGGESTIONS[f] || `Adicionar ${f}`),
      estimatedMatches: 0
    };
  }

  if (analysis.strategy === 'refine') {
    return {
      status: 'REFINE_REQUIRED',
      message: formatCardinalityMessage(analysis, cardinality),
      suggestions: analysis.missingFields.map(f => FIELD_SUGGESTIONS[f] || `Adicionar ${f}`),
      estimatedMatches: cardinality.estimatedMatches
    };
  }

  // Even for federated/direct, warn if cardinality is very high
  // Only block for heuristic-based estimates (not actual DB counts)
  if (cardinality.estimatedMatches > 100000 && cardinality.source === 'heuristic') {
    return {
      status: 'REFINE_REQUIRED',
      message: `Estimativa de ${formatNumber(cardinality.estimatedMatches)} correspondências possíveis. Refine a busca para resultados mais precisos.`,
      suggestions: analysis.missingFields.map(f => FIELD_SUGGESTIONS[f] || `Adicionar ${f}`),
      estimatedMatches: cardinality.estimatedMatches
    };
  }

  return {
    status: 'OK',
    message: null,
    suggestions: [],
    estimatedMatches: cardinality.estimatedMatches
  };
}

const FIELD_SUGGESTIONS = {
  nome: 'Informar nome completo (nome e sobrenome)',
  cidade: 'Adicionar cidade',
  cidadeUf: 'Adicionar cidade/UF',
  dataNascimento: 'Adicionar data de nascimento',
  segmento: 'Adicionar segmento ou CNAE',
  cpf: 'Informar CPF para busca exata',
  cnpj: 'Informar CNPJ para busca exata'
};

function formatCardinalityMessage(analysis, cardinality) {
  const est = cardinality.estimatedMatches;
  if (est > 1_000_000) {
    return `${analysis.reason} Existem milhões de possíveis correspondências no Brasil.`;
  }
  if (est > 10_000) {
    return `${analysis.reason} Existem ~${formatNumber(est)} possíveis correspondências.`;
  }
  if (est > 1_000) {
    return `${analysis.reason} Existem ~${formatNumber(est)} possíveis correspondências.`;
  }
  return analysis.reason;
}

function formatNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toString();
}

// ============================================
// EVIDENCE LOGGING
// ============================================

/**
 * Log search evidence for audit trail.
 *
 * @param {Object} evidence
 * @param {string} evidence.requestId
 * @param {Object} evidence.input - Original input
 * @param {Object} evidence.analysis - Query analysis result
 * @param {Object} evidence.cardinality - Cardinality estimation
 * @param {string} evidence.strategy - Strategy used
 * @param {string[]} evidence.sourcesUsed - Sources consulted
 * @param {number} evidence.returnedCount - Number of results returned
 * @param {number} evidence.durationMs - Total duration
 */
export function logEvidence(evidence) {
  logger.info('SEARCH_EVIDENCE', {
    requestId: evidence.requestId,
    input: evidence.input,
    type: evidence.analysis?.type,
    strength: evidence.analysis?.strength,
    strategy: evidence.analysis?.strategy,
    estimatedMatches: evidence.cardinality?.estimatedMatches,
    dbCount: evidence.cardinality?.dbCount,
    sourcesUsed: evidence.sourcesUsed,
    returnedCount: evidence.returnedCount,
    durationMs: evidence.durationMs
  });
}

export default {
  analyzeQuery,
  estimateCardinality,
  rankResults,
  buildRefinementResponse,
  logEvidence
};
