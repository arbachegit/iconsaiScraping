/**
 * Report Engine
 * Generates BI reports by assembling data from multiple services
 * and the graph analytics pipeline.
 */

import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { computeGraphAnalytics } from './graph-analytics.js';
import { getNetworkStats } from './graph-queries.js';
import {
  getEvidenceForEntity,
  combineConfidence,
} from './evidence-manager.js';

// ── Report catalog cache ──
let catalogCache = null;
let catalogCacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * Get report catalog from DB (cached).
 * @returns {Promise<Array>}
 */
export async function getReportCatalog() {
  if (catalogCache && Date.now() - catalogCacheTs < CACHE_TTL) return catalogCache;

  const { data, error } = await supabase
    .from('dim_relatorios')
    .select('*')
    .eq('ativo', true)
    .order('categoria')
    .order('nome');

  if (error) {
    logger.error('report_catalog_error', { error: error.message });
    return catalogCache || [];
  }

  catalogCache = data || [];
  catalogCacheTs = Date.now();
  return catalogCache;
}

/**
 * Get reports available for a given context.
 * @param {string} contextCode
 * @returns {Promise<Array>}
 */
export async function getReportsForContext(contextCode) {
  const { data, error } = await supabase
    .from('map_contexto_relatorio')
    .select(`
      prioridade,
      dim_relatorios (
        id, codigo, nome, descricao, categoria, template_sections
      )
    `)
    .eq('ativo', true)
    .order('prioridade', { ascending: false });

  if (error) {
    logger.error('reports_for_context_error', { contextCode, error: error.message });
    return [];
  }

  // Filter by context (join through dim_contextos)
  const { data: ctx } = await supabase
    .from('dim_contextos')
    .select('id')
    .eq('codigo', contextCode)
    .single();

  if (!ctx) return [];

  const filtered = (data || []).filter(m =>
    m.dim_relatorios // valid join
  );

  return filtered.map(m => ({
    ...m.dim_relatorios,
    prioridade: m.prioridade,
  }));
}

/**
 * Generate a report for an entity.
 *
 * @param {string} reportCode - Report template code
 * @param {string} entityType - Entity type
 * @param {string} entityId - Entity ID
 * @param {Object} [options={}]
 * @returns {Promise<Object>} Generated report
 */
export async function generateReport(reportCode, entityType, entityId, options = {}) {
  const startTime = Date.now();

  try {
    // 1. Get report template
    const catalog = await getReportCatalog();
    const template = catalog.find(r => r.codigo === reportCode);
    if (!template) {
      return { error: `Relatório '${reportCode}' não encontrado no catálogo` };
    }

    logger.info('report_generation_start', { reportCode, entityType, entityId });

    // 2. Collect data based on report type
    const sections = [];
    const metricas = {};
    let graphAnalytics = null;
    let scoreGeral = null;

    // Dispatch to specific generators
    switch (reportCode) {
      case 'perfil_completo':
        await generatePerfilCompleto(entityType, entityId, sections, metricas);
        break;
      case 'analise_rede':
        graphAnalytics = await generateAnaliseRede(entityType, entityId, sections, metricas);
        break;
      case 'prospeccao_comercial':
        await generateProspeccao(entityType, entityId, sections, metricas);
        break;
      case 'risco_fornecedor':
        await generateRiscoFornecedor(entityType, entityId, sections, metricas);
        break;
      case 'mapa_concorrencia':
        await generateMapaConcorrencia(entityType, entityId, sections, metricas);
        break;
      case 'due_diligence':
        graphAnalytics = await generateDueDiligence(entityType, entityId, sections, metricas);
        break;
      default:
        return { error: `Generator não implementado para '${reportCode}'` };
    }

    // Calculate overall score from metrics
    scoreGeral = calculateOverallScore(metricas);

    // 3. Get entity name for title
    const entityName = await resolveEntityName(entityType, entityId);
    const titulo = `${template.nome} — ${entityName}`;

    // 4. Generate executive summary
    const resumo = generateSummaryText(template.nome, entityName, metricas, sections);

    // 5. Persist report
    const { data: saved, error: saveError } = await supabase
      .from('fato_relatorios_gerados')
      .insert({
        relatorio_id: template.id,
        entidade_type: entityType,
        entidade_id: entityId,
        titulo,
        resumo,
        sections,
        metricas,
        score_geral: scoreGeral,
        graph_analytics: graphAnalytics,
        status: 'gerado',
        gerado_por: options.gerado_por || 'sistema',
        expires_at: options.expires_at || null,
      })
      .select()
      .single();

    if (saveError) {
      logger.error('report_save_error', { reportCode, error: saveError.message });
      // Return unsaved report anyway
      return {
        titulo,
        resumo,
        sections,
        metricas,
        score_geral: scoreGeral,
        graph_analytics: graphAnalytics,
        template: template.codigo,
        duration_ms: Date.now() - startTime,
        persisted: false,
      };
    }

    logger.info('report_generation_complete', {
      reportCode, entityType, entityId,
      reportId: saved.id, duration_ms: Date.now() - startTime,
    });

    return {
      id: saved.id,
      ...saved,
      template: template.codigo,
      duration_ms: Date.now() - startTime,
      persisted: true,
    };
  } catch (err) {
    logger.error('report_generation_error', { reportCode, entityType, entityId, error: err.message });
    return { error: err.message, duration_ms: Date.now() - startTime };
  }
}

/**
 * List generated reports for an entity.
 * @param {string} entityType
 * @param {string} entityId
 * @param {Object} [filters={}]
 * @returns {Promise<Array>}
 */
export async function listReports(entityType, entityId, filters = {}) {
  let query = supabase
    .from('fato_relatorios_gerados')
    .select(`
      id, titulo, resumo, score_geral, status, created_at,
      dim_relatorios (codigo, nome, categoria)
    `)
    .eq('entidade_type', entityType)
    .eq('entidade_id', entityId)
    .order('created_at', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.categoria) query = query.eq('dim_relatorios.categoria', filters.categoria);

  const limit = Math.min(filters.limit || 20, 100);
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    logger.error('list_reports_error', { entityType, entityId, error: error.message });
    return [];
  }
  return data || [];
}

/**
 * Get a single generated report by ID.
 * @param {string} reportId
 * @returns {Promise<Object|null>}
 */
export async function getReport(reportId) {
  const { data, error } = await supabase
    .from('fato_relatorios_gerados')
    .select(`
      *,
      dim_relatorios (codigo, nome, descricao, categoria, template_sections)
    `)
    .eq('id', reportId)
    .single();

  if (error) {
    logger.error('get_report_error', { reportId, error: error.message });
    return null;
  }
  return data;
}

// ═══════════════════════════════════════════════════════════
// Report generators
// ═══════════════════════════════════════════════════════════

async function generatePerfilCompleto(entityType, entityId, sections, metricas) {
  // Cadastral data
  const { data: empresa } = await supabase
    .from('dim_empresas')
    .select('*')
    .eq('id', entityId)
    .single();

  if (empresa) {
    sections.push({
      key: 'cadastral',
      titulo: 'Dados Cadastrais',
      tipo: 'tabela',
      data: {
        razao_social: empresa.razao_social,
        nome_fantasia: empresa.nome_fantasia,
        cnpj: empresa.cnpj,
        cidade: empresa.cidade,
        estado: empresa.estado,
        situacao: empresa.situacao_cadastral,
        data_abertura: empresa.data_abertura,
      },
    });
  }

  // Fiscal profile
  const { data: fiscal } = await supabase
    .from('fato_perfil_tributario')
    .select('*')
    .eq('empresa_id', entityId)
    .single();

  if (fiscal) {
    sections.push({
      key: 'fiscal',
      titulo: 'Perfil Fiscal',
      tipo: 'tabela',
      data: {
        regime: fiscal.regime_tributario,
        porte: fiscal.porte_estimado,
        faturamento_min: fiscal.faturamento_estimado_min,
        faturamento_max: fiscal.faturamento_estimado_max,
        saude_fiscal: fiscal.score_saude_fiscal,
        perfil_comprador: fiscal.perfil_comprador,
      },
    });
    metricas.saude_fiscal = fiscal.score_saude_fiscal;
    metricas.porte = fiscal.porte_estimado;
  }

  // CNAE profile
  const { data: cnae } = await supabase
    .from('fato_perfil_cnae')
    .select('*')
    .eq('empresa_id', entityId)
    .single();

  if (cnae) {
    sections.push({
      key: 'cnae',
      titulo: 'Classificação CNAE',
      tipo: 'tabela',
      data: {
        setor: cnae.setor_economico,
        cadeia_valor: cnae.cadeia_valor,
        posicao: cnae.posicao_cadeia,
      },
    });
    metricas.setor = cnae.setor_economico;
  }

  // Ecosystem
  const { data: eco } = await supabase
    .from('dim_ecossistema_empresas')
    .select('tipo_relacao, empresa_relacionada_id')
    .eq('empresa_id', entityId)
    .eq('ativo', true);

  if (eco && eco.length > 0) {
    const ecoGrouped = {};
    for (const r of eco) {
      const t = r.tipo_relacao;
      ecoGrouped[t] = (ecoGrouped[t] || 0) + 1;
    }
    sections.push({
      key: 'ecossistema',
      titulo: 'Ecossistema',
      tipo: 'lista',
      data: ecoGrouped,
    });
    metricas.total_ecossistema = eco.length;
  }

  // Opportunities
  const { data: opps } = await supabase
    .from('fato_oportunidades')
    .select('tipo_oportunidade, score_oportunidade, lead_temperatura, justificativa')
    .eq('empresa_origem_id', entityId)
    .order('score_oportunidade', { ascending: false })
    .limit(10);

  if (opps && opps.length > 0) {
    sections.push({
      key: 'oportunidades',
      titulo: 'Oportunidades',
      tipo: 'lista_scored',
      data: opps,
    });
    metricas.total_oportunidades = opps.length;
    metricas.melhor_score = opps[0]?.score_oportunidade || 0;
  }

  // Network stats
  const netStats = await getNetworkStats(entityType, entityId);
  sections.push({
    key: 'grafo',
    titulo: 'Análise de Rede',
    tipo: 'graph_analytics',
    data: netStats,
  });
  metricas.total_relacoes = netStats.total_relationships;
}

async function generateAnaliseRede(entityType, entityId, sections, metricas) {
  const analytics = await computeGraphAnalytics(entityType, entityId, { hops: 2 });

  if (analytics.error) {
    sections.push({ key: 'resumo', titulo: 'Resumo da Rede', tipo: 'texto', data: analytics.error });
    return null;
  }

  sections.push({
    key: 'centralidade',
    titulo: 'Métricas de Centralidade',
    tipo: 'tabela',
    data: analytics.root_metrics,
  });

  sections.push({
    key: 'comunidades',
    titulo: 'Comunidades Detectadas',
    tipo: 'lista',
    data: analytics.communities,
  });

  sections.push({
    key: 'influenciadores',
    titulo: 'Nós Influenciadores',
    tipo: 'lista_scored',
    data: analytics.top_influencers,
  });

  if (analytics.bridges.length > 0) {
    sections.push({
      key: 'caminhos',
      titulo: 'Pontes Críticas',
      tipo: 'lista',
      data: analytics.bridges,
    });
  }

  metricas.total_nos = analytics.summary.total_nodes;
  metricas.total_arestas = analytics.summary.total_edges;
  metricas.comunidades = analytics.summary.total_communities;
  metricas.pontes = analytics.summary.total_bridges;
  metricas.degree = analytics.root_metrics.degree;
  metricas.betweenness = analytics.root_metrics.betweenness;
  metricas.pagerank = analytics.root_metrics.pagerank;

  return analytics;
}

async function generateProspeccao(entityType, entityId, sections, metricas) {
  // Hot leads
  const { data: hotLeads } = await supabase
    .from('fato_oportunidades')
    .select('*')
    .eq('empresa_origem_id', entityId)
    .eq('lead_temperatura', 'quente')
    .order('lead_score', { ascending: false })
    .limit(10);

  sections.push({
    key: 'leads_quentes',
    titulo: 'Leads Quentes',
    tipo: 'lista_scored',
    data: hotLeads || [],
  });

  // Warm leads
  const { data: warmLeads } = await supabase
    .from('fato_oportunidades')
    .select('*')
    .eq('empresa_origem_id', entityId)
    .eq('lead_temperatura', 'morno')
    .order('lead_score', { ascending: false })
    .limit(10);

  sections.push({
    key: 'leads_mornos',
    titulo: 'Leads Mornos',
    tipo: 'lista_scored',
    data: warmLeads || [],
  });

  // Recommended actions
  const actions = [];
  if ((hotLeads || []).length > 0) {
    actions.push('Priorizar contato com leads quentes nas próximas 48h');
    actions.push(`${(hotLeads || []).length} leads com alta probabilidade de conversão`);
  }
  if ((warmLeads || []).length > 0) {
    actions.push('Nutrir leads mornos com conteúdo de valor');
  }

  sections.push({
    key: 'acoes',
    titulo: 'Ações Recomendadas',
    tipo: 'lista',
    data: actions,
  });

  // Pipeline summary
  const { data: allOpps } = await supabase
    .from('fato_oportunidades')
    .select('tipo_oportunidade, score_oportunidade, lead_temperatura, status')
    .eq('empresa_origem_id', entityId);

  const pipeline = {};
  for (const opp of (allOpps || [])) {
    const key = opp.lead_temperatura || 'sem_temperatura';
    pipeline[key] = (pipeline[key] || 0) + 1;
  }

  sections.push({
    key: 'pipeline',
    titulo: 'Pipeline de Oportunidades',
    tipo: 'tabela',
    data: pipeline,
  });

  metricas.leads_quentes = (hotLeads || []).length;
  metricas.leads_mornos = (warmLeads || []).length;
  metricas.total_pipeline = (allOpps || []).length;
}

async function generateRiscoFornecedor(entityType, entityId, sections, metricas) {
  // Fiscal health
  const { data: fiscal } = await supabase
    .from('fato_perfil_tributario')
    .select('*')
    .eq('empresa_id', entityId)
    .single();

  sections.push({
    key: 'saude_fiscal',
    titulo: 'Saúde Fiscal',
    tipo: 'tabela',
    data: fiscal || { status: 'Sem dados fiscais disponíveis' },
  });

  // Dependencies (who depends on this entity)
  const { data: deps } = await supabase
    .from('fato_relacoes_entidades')
    .select('source_type, source_id, tipo_relacao, strength')
    .eq('target_type', entityType)
    .eq('target_id', entityId)
    .eq('ativo', true)
    .in('tipo_relacao', ['fornecedor_de', 'fornecedor'])
    .order('strength', { ascending: false });

  sections.push({
    key: 'dependencias',
    titulo: 'Dependências',
    tipo: 'lista',
    data: (deps || []).map(d => ({
      type: d.source_type,
      id: d.source_id,
      relacao: d.tipo_relacao,
      forca: d.strength,
    })),
  });

  // Alerts
  const alertas = [];
  if (!fiscal) alertas.push('Sem dados fiscais — impossível avaliar saúde financeira');
  if (fiscal && fiscal.score_saude_fiscal < 0.4) alertas.push('Score de saúde fiscal baixo (<40%)');
  if ((deps || []).length === 0) alertas.push('Nenhum cliente identificado — possível empresa inativa');

  // Check evidence quality
  const evidences = await getEvidenceForEntity(entityType, entityId, { limit: 50 });
  const confidence = combineConfidence(evidences);
  if (confidence < 0.5) alertas.push(`Confiança agregada baixa (${Math.round(confidence * 100)}%)`);

  sections.push({
    key: 'alertas',
    titulo: 'Alertas',
    tipo: 'lista',
    data: alertas,
  });

  // Risk score: inverse of fiscal health
  const riskScore = fiscal?.score_saude_fiscal
    ? Math.round((1 - fiscal.score_saude_fiscal) * 100)
    : 50;

  sections.push({
    key: 'score_risco',
    titulo: 'Score de Risco',
    tipo: 'score',
    data: { score: riskScore, label: riskScore >= 70 ? 'Alto' : riskScore >= 40 ? 'Médio' : 'Baixo' },
  });

  metricas.score_risco = riskScore;
  metricas.alertas = alertas.length;
  metricas.dependencias = (deps || []).length;
  metricas.confianca_evidencias = Math.round(confidence * 100);
}

async function generateMapaConcorrencia(entityType, entityId, sections, metricas) {
  // Competitors from ecosystem
  const { data: competitors } = await supabase
    .from('dim_ecossistema_empresas')
    .select('empresa_relacionada_id, fonte_deteccao')
    .eq('empresa_id', entityId)
    .eq('tipo_relacao', 'concorrente')
    .eq('ativo', true);

  // Get competitor names
  const compIds = (competitors || []).map(c => c.empresa_relacionada_id).filter(Boolean);
  let competitorDetails = [];
  if (compIds.length > 0) {
    const { data } = await supabase
      .from('dim_empresas')
      .select('id, razao_social, nome_fantasia, cidade, estado')
      .in('id', compIds);
    competitorDetails = data || [];
  }

  sections.push({
    key: 'concorrentes',
    titulo: 'Concorrentes Diretos',
    tipo: 'lista_scored',
    data: competitorDetails.map(c => ({
      nome: c.nome_fantasia || c.razao_social,
      cidade: c.cidade,
      estado: c.estado,
    })),
  });

  // Geographic distribution from CNAE profile
  const { data: geo } = await supabase
    .from('fato_perfil_geografico')
    .select('*')
    .eq('empresa_id', entityId)
    .single();

  if (geo) {
    sections.push({
      key: 'geografico',
      titulo: 'Distribuição Geográfica',
      tipo: 'tabela',
      data: {
        arco_atuacao: geo.arco_atuacao,
        saturacao: geo.indice_saturacao,
        populacao_alcancavel: geo.populacao_alcancavel,
      },
    });
  }

  // CNAE profile for market positioning
  const { data: cnae } = await supabase
    .from('fato_perfil_cnae')
    .select('*')
    .eq('empresa_id', entityId)
    .single();

  if (cnae) {
    sections.push({
      key: 'market_share',
      titulo: 'Market Share Estimado',
      tipo: 'tabela',
      data: {
        setor: cnae.setor_economico,
        empresas_municipio: cnae.total_empresas_mesmo_cnae_municipio,
        empresas_estado: cnae.total_empresas_mesmo_cnae_estado,
        posicao_cadeia: cnae.posicao_cadeia,
      },
    });
  }

  metricas.total_concorrentes = competitorDetails.length;
  metricas.saturacao = geo?.indice_saturacao || null;
}

async function generateDueDiligence(entityType, entityId, sections, metricas) {
  // Reuse perfil_completo data
  await generatePerfilCompleto(entityType, entityId, sections, metricas);

  // Add socios
  const { data: socios } = await supabase
    .from('dim_pessoas')
    .select('nome_completo, cargo_atual, linkedin_url')
    .in('id',
      (await supabase
        .from('fato_relacoes_entidades')
        .select('source_id')
        .eq('target_type', 'empresa')
        .eq('target_id', entityId)
        .eq('source_type', 'pessoa')
        .eq('tipo_relacao', 'societaria')
        .eq('ativo', true)
        .limit(20)
      ).data?.map(r => r.source_id) || []
    );

  sections.push({
    key: 'socios',
    titulo: 'Quadro Societário',
    tipo: 'lista',
    data: socios || [],
  });

  // Red flags
  const alertas = [];
  const { data: empresa } = await supabase
    .from('dim_empresas')
    .select('situacao_cadastral, data_abertura')
    .eq('id', entityId)
    .single();

  if (empresa?.situacao_cadastral && empresa.situacao_cadastral !== 'ATIVA') {
    alertas.push(`Situação cadastral: ${empresa.situacao_cadastral}`);
  }
  if (empresa?.data_abertura) {
    const age = (Date.now() - new Date(empresa.data_abertura).getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 2) alertas.push('Empresa com menos de 2 anos de operação');
  }
  if (metricas.saude_fiscal && metricas.saude_fiscal < 0.3) {
    alertas.push('Saúde fiscal crítica (<30%)');
  }

  sections.push({
    key: 'alertas',
    titulo: 'Red Flags',
    tipo: 'lista',
    data: alertas,
  });

  metricas.red_flags = alertas.length;

  // Graph analytics
  const analytics = await computeGraphAnalytics(entityType, entityId, { hops: 2 });
  if (!analytics.error) {
    sections.push({
      key: 'rede',
      titulo: 'Rede de Relações',
      tipo: 'graph_analytics',
      data: analytics.summary,
    });
    metricas.influencia = analytics.root_metrics?.pagerank || 0;
  }

  // Overall score
  const ddScore = calculateDueDiligenceScore(metricas, alertas.length);
  sections.push({
    key: 'score',
    titulo: 'Score Final',
    tipo: 'score',
    data: { score: ddScore, label: ddScore >= 70 ? 'Aprovado' : ddScore >= 40 ? 'Atenção' : 'Reprovado' },
  });

  metricas.score_due_diligence = ddScore;

  return analytics.error ? null : analytics;
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function calculateOverallScore(metricas) {
  const scores = [];
  if (metricas.saude_fiscal != null) scores.push(metricas.saude_fiscal * 100);
  if (metricas.melhor_score != null) scores.push(metricas.melhor_score);
  if (metricas.confianca_evidencias != null) scores.push(metricas.confianca_evidencias);
  if (metricas.score_due_diligence != null) scores.push(metricas.score_due_diligence);
  if (metricas.score_risco != null) scores.push(100 - metricas.score_risco); // invert risk

  if (scores.length === 0) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function calculateDueDiligenceScore(metricas, redFlags) {
  let score = 70; // baseline
  if (metricas.saude_fiscal) score += (metricas.saude_fiscal - 0.5) * 30;
  if (metricas.total_ecossistema > 3) score += 5;
  if (metricas.total_relacoes > 5) score += 5;
  score -= redFlags * 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function resolveEntityName(entityType, entityId) {
  const tableMap = {
    empresa: { table: 'dim_empresas', field: 'nome_fantasia', fallback: 'razao_social' },
    pessoa: { table: 'dim_pessoas', field: 'nome_completo' },
    politico: { table: 'dim_politicos', field: 'nome_completo' },
  };

  const config = tableMap[entityType];
  if (!config) return `${entityType} #${entityId}`;

  const { data } = await supabase
    .from(config.table)
    .select(`${config.field}${config.fallback ? `, ${config.fallback}` : ''}`)
    .eq('id', entityId)
    .single();

  if (!data) return `${entityType} #${entityId}`;
  return data[config.field] || data[config.fallback] || `${entityType} #${entityId}`;
}

function generateSummaryText(reportName, entityName, metricas, sections) {
  const parts = [`Relatório "${reportName}" gerado para ${entityName}.`];

  if (metricas.total_relacoes) parts.push(`Rede com ${metricas.total_relacoes} relações identificadas.`);
  if (metricas.total_oportunidades) parts.push(`${metricas.total_oportunidades} oportunidades mapeadas.`);
  if (metricas.leads_quentes) parts.push(`${metricas.leads_quentes} leads quentes para ação imediata.`);
  if (metricas.total_concorrentes) parts.push(`${metricas.total_concorrentes} concorrentes identificados.`);
  if (metricas.red_flags) parts.push(`${metricas.red_flags} alertas identificados.`);
  if (metricas.saude_fiscal != null) parts.push(`Saúde fiscal: ${Math.round(metricas.saude_fiscal * 100)}%.`);

  return parts.join(' ');
}
