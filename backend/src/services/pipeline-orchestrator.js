/**
 * Pipeline Orchestrator Service
 * Unified orchestrator for the full BI intelligence pipeline (8 phases).
 *
 * Phases:
 * 1. Gemini Website Crawl
 * 2. CNAE Correlation (parallel with 3,4)
 * 3. Tax Profiling (parallel with 2,4)
 * 4. Geographic Analysis (parallel with 2,3)
 * 5. Taxonomy Classification
 * 6. News & Evidence Analysis
 * 7. Opportunity Scoring
 * 8. Graph Integration
 *
 * Each phase reports status to an in-memory tracker so the frontend
 * can poll progress via GET /api/pipeline/status/:runId.
 */

import logger from '../utils/logger.js';
import { supabase } from '../database/supabase.js';
import { sanitizeUUID } from '../utils/sanitize.js';
import { crawlCompanyWebsite } from './gemini-crawl.js';
import { buildCnaeProfile, findCnaeRelationships } from './cnae-correlator.js';
import { buildTaxProfile } from './tax-profiler.js';
import { buildGeoProfile } from './geo-analyzer.js';
import { classifyCompany } from './taxonomy-classifier.js';
import { scoreAllOpportunities } from './opportunity-scorer.js';
import { enrichRelationshipsAfterApproval } from './graph-pipeline.js';
import {
  getEvidenceForEntity,
} from './evidence-manager.js';

/**
 * Pipeline phase definitions.
 */
export const PIPELINE_PHASES = [
  { key: 'crawl', label: 'Website Crawl (Gemini)', order: 1 },
  { key: 'cnae', label: 'Correlação CNAE', order: 2 },
  { key: 'tax', label: 'Perfil Tributário', order: 3 },
  { key: 'geo', label: 'Perfil Geográfico', order: 4 },
  { key: 'taxonomy', label: 'Classificação Taxonômica', order: 5 },
  { key: 'evidence', label: 'Análise de Evidências', order: 6 },
  { key: 'scoring', label: 'Scoring de Oportunidades', order: 7 },
  { key: 'graph', label: 'Integração com Grafo', order: 8 },
];

/**
 * In-memory pipeline run tracker.
 * Key: runId, Value: PipelineRun object.
 * Entries auto-expire after 1 hour.
 */
const runs = new Map();

const RUN_TTL_MS = 60 * 60 * 1000; // 1 hour

function cleanExpiredRuns() {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (now - new Date(run.started_at).getTime() > RUN_TTL_MS) {
      runs.delete(id);
    }
  }
}

// Clean every 10 minutes
setInterval(cleanExpiredRuns, 10 * 60 * 1000);

/**
 * Create a new pipeline run tracking object.
 */
function createRun(empresaId, options = {}) {
  const runId = crypto.randomUUID();
  const phases = {};

  for (const phase of PIPELINE_PHASES) {
    const skipped = phase.key === 'crawl' && options.skipCrawl;
    phases[phase.key] = {
      key: phase.key,
      label: phase.label,
      order: phase.order,
      status: skipped ? 'skipped' : 'pending', // pending, running, success, error, skipped
      started_at: null,
      completed_at: null,
      duration_ms: null,
      result: null,
      error: null,
    };
  }

  const run = {
    id: runId,
    empresa_id: empresaId,
    status: 'running', // running, completed, error
    started_at: new Date().toISOString(),
    completed_at: null,
    total_duration_ms: null,
    phases,
    options,
    summary: null,
  };

  runs.set(runId, run);
  return run;
}

/**
 * Update a phase in a pipeline run.
 */
function updatePhase(runId, phaseKey, updates) {
  const run = runs.get(runId);
  if (!run || !run.phases[phaseKey]) return;

  Object.assign(run.phases[phaseKey], updates);
}

/**
 * Start a phase timer.
 */
function startPhase(runId, phaseKey) {
  updatePhase(runId, phaseKey, {
    status: 'running',
    started_at: new Date().toISOString(),
  });
}

/**
 * Complete a phase with result.
 */
function completePhase(runId, phaseKey, result = null) {
  const run = runs.get(runId);
  if (!run || !run.phases[phaseKey]) return;

  const phase = run.phases[phaseKey];
  const now = new Date();
  const started = phase.started_at ? new Date(phase.started_at) : now;

  updatePhase(runId, phaseKey, {
    status: 'success',
    completed_at: now.toISOString(),
    duration_ms: now.getTime() - started.getTime(),
    result,
  });
}

/**
 * Fail a phase with error.
 */
function failPhase(runId, phaseKey, error) {
  const run = runs.get(runId);
  if (!run || !run.phases[phaseKey]) return;

  const phase = run.phases[phaseKey];
  const now = new Date();
  const started = phase.started_at ? new Date(phase.started_at) : now;

  updatePhase(runId, phaseKey, {
    status: 'error',
    completed_at: now.toISOString(),
    duration_ms: now.getTime() - started.getTime(),
    error: error?.message || String(error),
  });
}

/**
 * Get pipeline run status.
 */
export function getPipelineStatus(runId) {
  return runs.get(runId) || null;
}

/**
 * List recent pipeline runs for a company.
 */
export function listPipelineRuns(empresaId, limit = 10) {
  const result = [];
  for (const run of runs.values()) {
    if (run.empresa_id === empresaId) {
      result.push(run);
    }
  }
  return result
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .slice(0, limit);
}

/**
 * Execute the full BI pipeline for a company.
 *
 * @param {string} empresaId - Company UUID
 * @param {Object} [options={}]
 * @param {boolean} [options.skipCrawl=false] - Skip website crawl phase
 * @param {boolean} [options.skipGraph=false] - Skip graph integration phase
 * @param {string[]} [options.onlyPhases] - Run only specific phases
 * @returns {Promise<Object>} Pipeline run result with all phase outcomes
 */
export async function executePipeline(empresaId, options = {}) {
  const id = sanitizeUUID(empresaId);
  if (!id) throw new Error('ID de empresa inválido');

  // Verify company exists
  const { data: empresa, error: empError } = await supabase
    .from('dim_empresas')
    .select('id, razao_social, nome_fantasia, cnpj, cidade, estado, cnae_id')
    .eq('id', id)
    .single();

  if (empError || !empresa) {
    throw new Error('Empresa não encontrada');
  }

  const run = createRun(id, options);
  const runId = run.id;

  logger.info('pipeline_start', {
    runId,
    empresaId: id,
    empresa: empresa.nome_fantasia || empresa.razao_social,
    options,
  });

  const shouldRun = (phaseKey) => {
    if (options.onlyPhases?.length) {
      return options.onlyPhases.includes(phaseKey);
    }
    return true;
  };

  try {
    // ── Phase 1: Gemini Website Crawl ──
    let crawlResult = null;
    if (shouldRun('crawl') && !options.skipCrawl) {
      startPhase(runId, 'crawl');
      try {
        crawlResult = await crawlCompanyWebsite(id, { force: options.forceCrawl });
        completePhase(runId, 'crawl', {
          status: crawlResult?.status || 'sem_website',
          produtos: crawlResult?.raw_extraction?.produtos?.length || 0,
          contatos: crawlResult?.raw_extraction?.contatos?.length || 0,
        });
      } catch (err) {
        failPhase(runId, 'crawl', err);
      }
    }

    // ── Phases 2, 3, 4: Parallel profile building ──
    const profilePromises = [];

    // Phase 2: CNAE
    if (shouldRun('cnae')) {
      startPhase(runId, 'cnae');
      profilePromises.push(
        buildCnaeProfile(id)
          .then((result) => {
            completePhase(runId, 'cnae', {
              setor: result?.setor_economico,
              cadeia: result?.cadeia_valor,
              concorrentes_municipio: result?.total_empresas_mesmo_cnae_municipio,
            });
            return { key: 'cnae', data: result };
          })
          .catch((err) => {
            failPhase(runId, 'cnae', err);
            return { key: 'cnae', data: null };
          })
      );
    }

    // Phase 3: Tax
    if (shouldRun('tax')) {
      startPhase(runId, 'tax');
      profilePromises.push(
        buildTaxProfile(id)
          .then((result) => {
            completePhase(runId, 'tax', {
              regime: result?.regime_tributario,
              porte: result?.porte,
              score_fiscal: result?.score_saude_fiscal,
            });
            return { key: 'tax', data: result };
          })
          .catch((err) => {
            failPhase(runId, 'tax', err);
            return { key: 'tax', data: null };
          })
      );
    }

    // Phase 4: Geo
    if (shouldRun('geo')) {
      startPhase(runId, 'geo');
      profilePromises.push(
        buildGeoProfile(id)
          .then((result) => {
            completePhase(runId, 'geo', {
              arco: result?.arco_atuacao,
              saturacao: result?.indice_saturacao,
              concorrentes: result?.densidade_concorrentes,
            });
            return { key: 'geo', data: result };
          })
          .catch((err) => {
            failPhase(runId, 'geo', err);
            return { key: 'geo', data: null };
          })
      );
    }

    const profileResults = await Promise.all(profilePromises);
    const profiles = {};
    for (const { key, data } of profileResults) {
      profiles[key] = data;
    }

    // ── Phase 5: Taxonomy ──
    let taxonomyResult = null;
    if (shouldRun('taxonomy')) {
      startPhase(runId, 'taxonomy');
      try {
        taxonomyResult = await classifyCompany(id);
        completePhase(runId, 'taxonomy', {
          codigo: taxonomyResult?.codigo,
          nome: taxonomyResult?.nome,
          nivel: taxonomyResult?.nivel,
        });
      } catch (err) {
        failPhase(runId, 'taxonomy', err);
      }
    }

    // ── Phase 6: Evidence Analysis ──
    let evidenceResult = null;
    if (shouldRun('evidence')) {
      startPhase(runId, 'evidence');
      try {
        const evidences = await getEvidenceForEntity('empresa', id, { limit: 200 });
        evidenceResult = {
          total: evidences.length,
          por_tipo: {},
          por_fonte: {},
        };
        for (const ev of evidences) {
          evidenceResult.por_tipo[ev.tipo_evidencia] = (evidenceResult.por_tipo[ev.tipo_evidencia] || 0) + 1;
          evidenceResult.por_fonte[ev.fonte] = (evidenceResult.por_fonte[ev.fonte] || 0) + 1;
        }
        completePhase(runId, 'evidence', evidenceResult);
      } catch (err) {
        failPhase(runId, 'evidence', err);
      }
    }

    // ── Phase 7: Opportunity Scoring ──
    let opportunities = [];
    if (shouldRun('scoring')) {
      startPhase(runId, 'scoring');
      try {
        opportunities = await scoreAllOpportunities(id, { limit: 50 });
        const quentes = opportunities.filter((o) => o.lead_temperatura === 'quente').length;
        const mornos = opportunities.filter((o) => o.lead_temperatura === 'morno').length;
        completePhase(runId, 'scoring', {
          total: opportunities.length,
          quentes,
          mornos,
          melhor_score: opportunities[0]?.score_oportunidade || 0,
        });
      } catch (err) {
        failPhase(runId, 'scoring', err);
      }
    }

    // ── Phase 8: Graph Integration ──
    let graphResult = null;
    if (shouldRun('graph') && !options.skipGraph) {
      startPhase(runId, 'graph');
      try {
        // Get socios for relationship detection
        const { data: socios } = await supabase
          .from('fato_transacao_empresas')
          .select('pessoa_id, qualificacao_socio')
          .eq('empresa_id', id);

        graphResult = await enrichRelationshipsAfterApproval({
          empresa_id: id,
          nome: empresa.nome_fantasia || empresa.razao_social,
          cidade: empresa.cidade,
          estado: empresa.estado,
          cnae: empresa.cnae_id,
          socios: (socios || []).map((s) => ({
            pessoa_id: s.pessoa_id,
            qualificacao: s.qualificacao_socio,
          })),
        });

        completePhase(runId, 'graph', {
          relacoes_detectadas: graphResult?.total || 0,
          tipos: graphResult?.por_tipo || {},
        });
      } catch (err) {
        failPhase(runId, 'graph', err);
      }
    }

    // ── Finalize ──
    const now = new Date();
    const totalMs = now.getTime() - new Date(run.started_at).getTime();

    const phaseStatuses = Object.values(run.phases);
    const hasErrors = phaseStatuses.some((p) => p.status === 'error');
    const successCount = phaseStatuses.filter((p) => p.status === 'success').length;
    const errorCount = phaseStatuses.filter((p) => p.status === 'error').length;
    const skippedCount = phaseStatuses.filter((p) => p.status === 'skipped' || p.status === 'pending').length;

    run.status = hasErrors ? 'completed_with_errors' : 'completed';
    run.completed_at = now.toISOString();
    run.total_duration_ms = totalMs;
    run.summary = {
      empresa: empresa.nome_fantasia || empresa.razao_social,
      cnpj: empresa.cnpj,
      phases_success: successCount,
      phases_error: errorCount,
      phases_skipped: skippedCount,
      total_duration_ms: totalMs,
      profiles: {
        cnae: !!profiles.cnae,
        tributario: !!profiles.tax,
        geografico: !!profiles.geo,
      },
      crawl: crawlResult?.status || 'skipped',
      taxonomy: taxonomyResult?.codigo || null,
      evidencias_total: evidenceResult?.total || 0,
      oportunidades_total: opportunities.length,
      oportunidades_quentes: opportunities.filter((o) => o.lead_temperatura === 'quente').length,
      grafo_relacoes: graphResult?.total || 0,
    };

    logger.info('pipeline_complete', {
      runId,
      empresaId: id,
      status: run.status,
      duration_ms: totalMs,
      summary: run.summary,
    });

    return run;
  } catch (err) {
    const now = new Date();
    run.status = 'error';
    run.completed_at = now.toISOString();
    run.total_duration_ms = now.getTime() - new Date(run.started_at).getTime();

    logger.error('pipeline_fatal_error', {
      runId,
      empresaId: id,
      error: err.message,
    });

    return run;
  }
}

/**
 * Execute pipeline for multiple companies in batch.
 *
 * @param {string[]} empresaIds - Company UUIDs
 * @param {Object} [options={}] - Pipeline options
 * @returns {Promise<Object>} Batch result summary
 */
export async function executeBatchPipeline(empresaIds, options = {}) {
  const results = [];

  for (const empresaId of empresaIds) {
    try {
      const run = await executePipeline(empresaId, options);
      results.push({ empresaId, runId: run.id, status: run.status });
    } catch (err) {
      results.push({ empresaId, runId: null, status: 'error', error: err.message });
    }
  }

  return {
    total: results.length,
    success: results.filter((r) => r.status === 'completed').length,
    errors: results.filter((r) => r.status === 'error').length,
    runs: results,
  };
}
