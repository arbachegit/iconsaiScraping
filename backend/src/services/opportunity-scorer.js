/**
 * Opportunity Scorer Service
 * Calculates composite opportunity score and lead temperature
 * for company-to-company relationships.
 *
 * Score = (Geo × 0.20) + (CNAE × 0.25) + (Tributário × 0.15) + (Temporal × 0.10) + (Evidência × 0.30)
 *
 * Lead Temperature:
 * - Quente (≥70): Direct evidence + same geo + compatible CNAE
 * - Morno (40-69): Partial evidence or compatibility
 * - Frio (<40): No direct evidence + low compatibility
 */

import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { sanitizeUUID } from '../utils/sanitize.js';
import { getEvidenceBetween, combineConfidence } from './evidence-manager.js';
import {
  OPPORTUNITY_WEIGHTS,
  LEAD_TEMPERATURA,
  OPORTUNIDADE_PRIORIDADE,
} from '../constants.js';

/**
 * Score an opportunity between two companies.
 *
 * @param {string} origemId - Source company UUID (the one selling/partnering)
 * @param {string} alvoId - Target company UUID (the one buying/consuming)
 * @param {string} tipoOportunidade - 'venda_direta' | 'parceria' | 'fornecimento' | 'expansao_geografica'
 * @returns {Promise<Object|null>} Opportunity record or null
 */
export async function scoreOpportunity(origemId, alvoId, tipoOportunidade) {
  const origId = sanitizeUUID(origemId);
  const tgtId = sanitizeUUID(alvoId);
  if (!origId || !tgtId) return null;

  try {
    // Fetch profiles for both companies in parallel
    const [
      origemCnae,
      alvoCnae,
      origemTrib,
      alvoTrib,
      origemGeo,
      alvoGeo,
      evidences,
    ] = await Promise.all([
      getProfile('fato_perfil_cnae', origId),
      getProfile('fato_perfil_cnae', tgtId),
      getProfile('fato_perfil_tributario', origId),
      getProfile('fato_perfil_tributario', tgtId),
      getProfile('fato_perfil_geografico', origId),
      getProfile('fato_perfil_geografico', tgtId),
      getEvidenceBetween('empresa', origId, 'empresa', tgtId),
    ]);

    // Calculate individual scores (0-100)
    const scoreGeo = calculateGeoScore(origemGeo, alvoGeo);
    const scoreCnae = calculateCnaeScore(origemCnae, alvoCnae, tipoOportunidade);
    const scoreTrib = calculateTribScore(origemTrib, alvoTrib);
    const scoreTemporal = calculateTemporalScore(); // Simplified for now
    const scoreEvidencia = calculateEvidenceScore(evidences);

    // Composite score
    const scoreOportunidade = Math.round(
      scoreGeo * OPPORTUNITY_WEIGHTS.GEOGRAFICO +
      scoreCnae * OPPORTUNITY_WEIGHTS.CNAE +
      scoreTrib * OPPORTUNITY_WEIGHTS.TRIBUTARIO +
      scoreTemporal * OPPORTUNITY_WEIGHTS.TEMPORAL +
      scoreEvidencia * OPPORTUNITY_WEIGHTS.EVIDENCIA
    );

    // Lead scoring
    const { temperatura, leadScore, sinais } = calculateLeadScore(
      scoreOportunidade,
      scoreGeo,
      scoreCnae,
      scoreEvidencia,
      evidences
    );

    // Priority
    const prioridade = scoreOportunidade >= 80
      ? OPORTUNIDADE_PRIORIDADE.CRITICA
      : scoreOportunidade >= 60
        ? OPORTUNIDADE_PRIORIDADE.ALTA
        : scoreOportunidade >= 40
          ? OPORTUNIDADE_PRIORIDADE.MEDIA
          : OPORTUNIDADE_PRIORIDADE.BAIXA;

    // Generate justification
    const justificativa = generateJustification(
      scoreGeo, scoreCnae, scoreTrib, scoreEvidencia, tipoOportunidade
    );

    // Generate recommended actions
    const acoes = generateActions(temperatura, tipoOportunidade);

    const record = {
      empresa_origem_id: origId,
      empresa_alvo_id: tgtId,
      tipo_oportunidade: tipoOportunidade,
      score_oportunidade: scoreOportunidade,
      score_geografico: scoreGeo,
      score_cnae: scoreCnae,
      score_tributario: scoreTrib,
      score_temporal: scoreTemporal,
      score_evidencia: scoreEvidencia,
      lead_temperatura: temperatura,
      lead_score: leadScore,
      lead_sinais: sinais,
      justificativa,
      acoes_recomendadas: acoes,
      prioridade,
      status: 'nova',
    };

    // Upsert
    const { data: existing } = await supabase
      .from('fato_oportunidades')
      .select('id')
      .eq('empresa_origem_id', origId)
      .eq('empresa_alvo_id', tgtId)
      .eq('tipo_oportunidade', tipoOportunidade)
      .limit(1);

    let saved;
    if (existing?.length > 0) {
      const { data, error } = await supabase
        .from('fato_oportunidades')
        .update({ ...record, updated_at: new Date().toISOString() })
        .eq('id', existing[0].id)
        .select()
        .single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('fato_oportunidades')
        .insert(record)
        .select()
        .single();
      if (error) throw error;
      saved = data;
    }

    logger.info('opportunity_scored', {
      origem: origId,
      alvo: tgtId,
      tipo: tipoOportunidade,
      score: scoreOportunidade,
      temperatura,
      prioridade,
    });

    return saved;
  } catch (err) {
    logger.error('opportunity_score_error', {
      origemId: origId,
      alvoId: tgtId,
      error: err.message,
    });
    return null;
  }
}

/**
 * Score all potential opportunities for a company based on ecosystem.
 *
 * @param {string} empresaId - Company UUID
 * @param {Object} [options={}]
 * @param {number} [options.limit=50] - Max opportunities to score
 * @returns {Promise<Array<Object>>} Scored opportunities
 */
export async function scoreAllOpportunities(empresaId, options = {}) {
  const id = sanitizeUUID(empresaId);
  if (!id) return [];

  const limit = Math.min(options.limit || 50, 200);

  // Get ecosystem relationships
  const { data: ecosystem } = await supabase
    .from('dim_ecossistema_empresas')
    .select('empresa_relacionada_id, tipo_relacao, nome_empresa_relacionada')
    .eq('empresa_id', id)
    .eq('ativo', true)
    .not('empresa_relacionada_id', 'is', null)
    .limit(limit);

  if (!ecosystem?.length) return [];

  const results = [];

  for (const rel of ecosystem) {
    const tipo = rel.tipo_relacao === 'cliente'
      ? 'venda_direta'
      : rel.tipo_relacao === 'fornecedor'
        ? 'fornecimento'
        : rel.tipo_relacao === 'parceiro'
          ? 'parceria'
          : null;

    if (!tipo) continue;

    const result = await scoreOpportunity(id, rel.empresa_relacionada_id, tipo);
    if (result) results.push(result);
  }

  results.sort((a, b) => b.score_oportunidade - a.score_oportunidade);

  logger.info('opportunities_batch_scored', {
    empresaId: id,
    total: results.length,
  });

  return results;
}

// --- Score calculation functions ---

function calculateGeoScore(origemGeo, alvoGeo) {
  if (!origemGeo || !alvoGeo) return 30; // Default if no data

  // Same city
  const origemCidades = origemGeo.municipios_atuacao || [];
  const alvoCidades = alvoGeo.municipios_atuacao || [];

  const sameCidade = origemCidades.some((c) => alvoCidades.includes(c));
  if (sameCidade) return 100;

  // Same state
  const origemEstados = origemGeo.estados_atuacao || [];
  const alvoEstados = alvoGeo.estados_atuacao || [];

  const sameEstado = origemEstados.some((e) => alvoEstados.includes(e));
  if (sameEstado) return 70;

  // Same region (simplified)
  return 30;
}

function calculateCnaeScore(origemCnae, alvoCnae, tipo) {
  if (!origemCnae || !alvoCnae) return 30;

  const origemDiv = origemCnae.cnae_principal?.replace(/[^\d]/g, '').substring(0, 2);
  const alvoDiv = alvoCnae.cnae_principal?.replace(/[^\d]/g, '').substring(0, 2);

  if (!origemDiv || !alvoDiv) return 30;

  // For venda_direta: target CNAE should be in our typical client list
  if (tipo === 'venda_direta') {
    if (origemCnae.cnaes_clientes_tipicos?.includes(alvoDiv)) return 100;
    if (origemCnae.setor_economico === alvoCnae.setor_economico) return 50;
    return 20;
  }

  // For fornecimento: target CNAE should be in our typical supplier list
  if (tipo === 'fornecimento') {
    if (origemCnae.cnaes_fornecedores_tipicos?.includes(alvoDiv)) return 100;
    return 20;
  }

  // For parceria: same sector or complementary
  if (origemCnae.setor_economico === alvoCnae.setor_economico) return 70;
  if (origemCnae.cadeia_valor === alvoCnae.cadeia_valor) return 50;

  return 30;
}

function calculateTribScore(origemTrib, alvoTrib) {
  if (!origemTrib || !alvoTrib) return 50;

  const porteMap = { MEI: 1, ME: 2, EPP: 3, MEDIO: 4, GRANDE: 5 };
  const origemPorte = porteMap[origemTrib.porte] || 3;
  const alvoPorte = porteMap[alvoTrib.porte] || 3;

  const diff = Math.abs(origemPorte - alvoPorte);

  // Same range = best compatibility
  if (diff === 0) return 100;
  if (diff === 1) return 70;
  if (diff === 2) return 40;
  return 20;
}

function calculateTemporalScore() {
  // Simplified: no temporal data yet
  // Will be enhanced with seasonal patterns and commemorative dates
  return 50;
}

function calculateEvidenceScore(evidences) {
  if (!evidences?.length) return 0;

  const combined = combineConfidence(evidences);
  return Math.round(combined * 100);
}

function calculateLeadScore(scoreOp, scoreGeo, scoreCnae, scoreEv, evidences) {
  // Lead Score = (Score_Op × 0.40) + (Recência × 0.25) + (Engajamento × 0.20) + (Fit × 0.15)
  const recency = calculateRecency(evidences);
  const engagement = evidences?.length > 0 ? Math.min(evidences.length * 20, 100) : 0;
  const fit = (scoreGeo + scoreCnae) / 2;

  const leadScore = Math.round(
    scoreOp * 0.40 +
    recency * 0.25 +
    engagement * 0.20 +
    fit * 0.15
  );

  // Temperature
  let temperatura;
  if (leadScore >= 70) temperatura = LEAD_TEMPERATURA.QUENTE;
  else if (leadScore >= 40) temperatura = LEAD_TEMPERATURA.MORNO;
  else temperatura = LEAD_TEMPERATURA.FRIO;

  // Signals
  const sinais = {
    tem_evidencia_direta: (evidences?.length || 0) > 0,
    mesmo_municipio: scoreGeo >= 100,
    cnae_compativel: scoreCnae >= 70,
    evidencia_recente: recency >= 70,
    multiplas_evidencias: (evidences?.length || 0) >= 3,
  };

  return { temperatura, leadScore, sinais };
}

function calculateRecency(evidences) {
  if (!evidences?.length) return 0;

  const now = Date.now();
  const newest = Math.max(
    ...evidences.map((e) => new Date(e.created_at).getTime())
  );
  const daysOld = (now - newest) / (24 * 60 * 60 * 1000);

  if (daysOld < 7) return 100;
  if (daysOld < 30) return 70;
  if (daysOld < 90) return 40;
  return 10;
}

function generateJustification(geo, cnae, trib, ev, tipo) {
  const parts = [];

  if (geo >= 70) parts.push('proximidade geográfica favorável');
  if (cnae >= 70) parts.push('CNAE compatível na cadeia de valor');
  if (trib >= 70) parts.push('porte empresarial compatível');
  if (ev >= 50) parts.push('evidências diretas de relação');

  if (parts.length === 0) parts.push('compatibilidade parcial detectada');

  return `Oportunidade de ${tipo.replace('_', ' ')}: ${parts.join(', ')}.`;
}

function generateActions(temperatura, tipo) {
  const actions = {
    quente: {
      venda_direta: [
        'Contatar departamento comercial imediatamente',
        'Preparar proposta personalizada',
        'Agendar reunião de apresentação',
      ],
      parceria: [
        'Enviar proposta de parceria',
        'Identificar sinergias operacionais',
        'Agendar reunião estratégica',
      ],
      fornecimento: [
        'Solicitar cotação',
        'Avaliar capacidade de fornecimento',
        'Verificar certificações',
      ],
      expansao_geografica: [
        'Avaliar ponto comercial na região',
        'Mapear demanda local',
        'Estimar investimento necessário',
      ],
    },
    morno: {
      venda_direta: [
        'Monitorar notícias sobre a empresa',
        'Incluir em mailing de prospecção',
        'Buscar contato em eventos do setor',
      ],
      parceria: [
        'Avaliar complementaridade de serviços',
        'Monitorar atividades recentes',
      ],
      fornecimento: [
        'Pesquisar reputação no mercado',
        'Comparar com fornecedores atuais',
      ],
      expansao_geografica: [
        'Coletar mais dados sobre a região',
        'Avaliar concorrência local',
      ],
    },
    frio: {
      venda_direta: ['Manter em banco de dados para futuro contato'],
      parceria: ['Monitorar evolução da empresa'],
      fornecimento: ['Manter como opção alternativa'],
      expansao_geografica: ['Reavaliar em 6 meses'],
    },
  };

  return actions[temperatura]?.[tipo] || ['Avaliar manualmente'];
}

// --- Helper ---

async function getProfile(table, empresaId) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('empresa_id', empresaId)
    .limit(1)
    .single();

  if (error) return null;
  return data;
}
