/**
 * Business Intelligence API Routes
 * Endpoints for the BI pipeline: profiles, ecosystem, opportunities, evidence.
 */

import { Router } from 'express';
import { z } from 'zod';
import logger from '../utils/logger.js';
import { sanitizeUUID, sanitizeForLog } from '../utils/sanitize.js';
import { validateQuery, biOpportunitiesQuerySchema, biLeadsQuerySchema, biEvidenceQuerySchema } from '../validation/schemas.js';
import { buildCnaeProfile, findCnaeRelationships } from '../services/cnae-correlator.js';
import { buildTaxProfile } from '../services/tax-profiler.js';
import { classifyCompany } from '../services/taxonomy-classifier.js';
import { crawlCompanyWebsite, crawlBatch } from '../services/gemini-crawl.js';
import { buildGeoProfile } from '../services/geo-analyzer.js';
import { scoreOpportunity, scoreAllOpportunities } from '../services/opportunity-scorer.js';
import {
  createEvidence,
  getEvidenceForEntity,
  getEvidenceBetween,
  combineConfidence,
} from '../services/evidence-manager.js';
import { supabase } from '../database/supabase.js';

const router = Router();

// --- Validation schemas ---

const uuidParam = z.object({
  empresaId: z.string().uuid(),
});

const entityParams = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
});

const evidenceBody = z.object({
  entidade_origem_type: z.string().min(1),
  entidade_origem_id: z.string().uuid(),
  entidade_destino_type: z.string().optional(),
  entidade_destino_id: z.string().uuid().optional(),
  tipo_evidencia: z.string().min(1),
  fonte: z.string().min(1),
  confianca: z.number().min(0).max(1).optional(),
  metodo_extracao: z.string().optional(),
  texto_evidencia: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  expires_at: z.string().datetime().optional(),
});

// --- Profile endpoints ---

/**
 * POST /api/bi/profile/:empresaId
 * Build all profiles (CNAE + Tax + Taxonomy) for a company.
 */
router.post('/profile/:empresaId', async (req, res) => {
  try {
    const { empresaId } = uuidParam.parse(req.params);

    const [cnaeProfile, taxProfile, taxonomy] = await Promise.all([
      buildCnaeProfile(empresaId),
      buildTaxProfile(empresaId),
      classifyCompany(empresaId),
    ]);

    res.json({
      success: true,
      data: {
        cnae: cnaeProfile,
        tributario: taxProfile,
        taxonomia: taxonomy,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('bi_profile_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao construir perfil' });
  }
});

/**
 * GET /api/bi/profile/:empresaId
 * Get existing profiles for a company.
 */
router.get('/profile/:empresaId', async (req, res) => {
  try {
    const { empresaId } = uuidParam.parse(req.params);

    const [cnae, tributario, geo] = await Promise.all([
      supabase.from('fato_perfil_cnae').select('*').eq('empresa_id', empresaId).single(),
      supabase.from('fato_perfil_tributario').select('*').eq('empresa_id', empresaId).single(),
      supabase.from('fato_perfil_geografico').select('*').eq('empresa_id', empresaId).single(),
    ]);

    res.json({
      success: true,
      data: {
        cnae: cnae.data,
        tributario: tributario.data,
        geografico: geo.data,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('bi_profile_get_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// --- Ecosystem endpoints ---

/**
 * GET /api/bi/ecosystem/:empresaId
 * Get ecosystem (clients, suppliers, competitors) for a company.
 */
router.get('/ecosystem/:empresaId', async (req, res) => {
  try {
    const { empresaId } = uuidParam.parse(req.params);

    // Fetch from dim_ecossistema_empresas
    const { data: ecosystem, error } = await supabase
      .from('dim_ecossistema_empresas')
      .select('*')
      .eq('empresa_id', empresaId)
      .eq('ativo', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Group by type
    const grouped = {
      clientes: [],
      fornecedores: [],
      concorrentes: [],
      parceiros: [],
    };

    for (const rel of (ecosystem || [])) {
      const key = `${rel.tipo_relacao}s`;
      if (grouped[key]) grouped[key].push(rel);
    }

    // Also get CNAE-based potential relationships
    const cnaeRelations = await findCnaeRelationships(empresaId);

    res.json({
      success: true,
      data: {
        confirmados: grouped,
        potenciais_cnae: cnaeRelations,
        total: (ecosystem || []).length,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('bi_ecosystem_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar ecossistema' });
  }
});

// --- Opportunities endpoints ---

/**
 * GET /api/bi/opportunities/:empresaId
 * List opportunities with score for a company.
 */
router.get('/opportunities/:empresaId', validateQuery(biOpportunitiesQuerySchema), async (req, res) => {
  try {
    const { empresaId } = uuidParam.parse(req.params);
    const { limit, status } = req.query;

    let query = supabase
      .from('fato_oportunidades')
      .select('*')
      .eq('empresa_origem_id', empresaId)
      .order('score_oportunidade', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data: data || [], total: (data || []).length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('bi_opportunities_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar oportunidades' });
  }
});

/**
 * GET /api/bi/opportunities/:empresaId/leads
 * List leads with temperature for a company.
 */
router.get('/opportunities/:empresaId/leads', validateQuery(biLeadsQuerySchema), async (req, res) => {
  try {
    const { empresaId } = uuidParam.parse(req.params);
    const { temperatura, limit } = req.query;

    let query = supabase
      .from('fato_oportunidades')
      .select('*')
      .eq('empresa_origem_id', empresaId)
      .not('lead_temperatura', 'is', null)
      .order('lead_score', { ascending: false })
      .limit(limit);

    if (temperatura) query = query.eq('lead_temperatura', temperatura);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data: data || [], total: (data || []).length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('bi_leads_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar leads' });
  }
});

// --- Evidence endpoints ---

/**
 * GET /api/bi/evidence/:entityType/:entityId
 * List evidence for an entity.
 */
router.get('/evidence/:entityType/:entityId', validateQuery(biEvidenceQuerySchema), async (req, res) => {
  try {
    const { entityType, entityId } = entityParams.parse(req.params);
    const { tipo, fonte, min_confianca } = req.query;
    const filters = {
      tipo_evidencia: tipo || undefined,
      fonte: fonte || undefined,
      min_confianca: min_confianca || undefined,
      limit: 100,
    };

    const evidences = await getEvidenceForEntity(entityType, entityId, filters);
    const aggregateConfidence = combineConfidence(evidences);

    res.json({
      success: true,
      data: evidences,
      total: evidences.length,
      aggregate_confidence: aggregateConfidence,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
    }
    logger.error('bi_evidence_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar evidências' });
  }
});

/**
 * POST /api/bi/evidence
 * Create a new evidence record.
 */
router.post('/evidence', async (req, res) => {
  try {
    const body = evidenceBody.parse(req.body);
    const evidence = await createEvidence(body);

    if (!evidence) {
      return res.status(400).json({ error: 'Não foi possível criar evidência' });
    }

    res.status(201).json({ success: true, data: evidence });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Dados inválidos', details: err.errors });
    }
    logger.error('bi_evidence_create_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao criar evidência' });
  }
});

// --- Context endpoints ---

/**
 * GET /api/bi/contexts
 * List all available analysis contexts.
 */
router.get('/contexts', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('dim_contextos')
      .select('*')
      .eq('ativo', true)
      .order('nome');

    if (error) throw error;

    res.json({ success: true, data: data || [] });
  } catch (err) {
    logger.error('bi_contexts_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar contextos' });
  }
});

// --- Taxonomy endpoints ---

/**
 * GET /api/bi/taxonomy
 * Return full taxonomy tree.
 */
router.get('/taxonomy', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('dim_taxonomia_empresa')
      .select('*')
      .eq('ativo', true)
      .order('nivel')
      .order('nome');

    if (error) throw error;

    // Build tree structure
    const sectors = (data || []).filter((d) => d.nivel === 1);
    const tree = sectors.map((sector) => ({
      ...sector,
      segmentos: (data || []).filter(
        (d) => d.nivel === 2 && d.pai_id === sector.id
      ),
    }));

    res.json({ success: true, data: tree });
  } catch (err) {
    logger.error('bi_taxonomy_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar taxonomia' });
  }
});

// --- Crawl endpoints ---

/**
 * POST /api/bi/crawl/:empresaId
 * Crawl a company website using Gemini.
 */
router.post('/crawl/:empresaId', async (req, res) => {
  try {
    const { empresaId } = uuidParam.parse(req.params);
    const force = req.query.force === 'true';

    const result = await crawlCompanyWebsite(empresaId, { force });

    if (!result) {
      return res.status(404).json({
        error: 'Não foi possível fazer crawl (sem website ou API key)',
      });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('bi_crawl_error', { error: err.message });
    res.status(500).json({ error: 'Erro no crawl' });
  }
});

/**
 * POST /api/bi/crawl/batch
 * Crawl a batch of companies.
 */
router.post('/crawl/batch', async (req, res) => {
  try {
    const batchSize = Math.min(parseInt(req.query.batch_size) || 10, 50);
    const result = await crawlBatch(batchSize);
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('bi_crawl_batch_error', { error: err.message });
    res.status(500).json({ error: 'Erro no batch crawl' });
  }
});

// --- Scoring endpoints ---

/**
 * POST /api/bi/score/:empresaId
 * Score all opportunities for a company.
 */
router.post('/score/:empresaId', async (req, res) => {
  try {
    const { empresaId } = uuidParam.parse(req.params);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const results = await scoreAllOpportunities(empresaId, { limit });

    res.json({
      success: true,
      data: results,
      total: results.length,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('bi_score_error', { error: err.message });
    res.status(500).json({ error: 'Erro no scoring' });
  }
});

/**
 * POST /api/bi/score/:origemId/:alvoId
 * Score a specific opportunity between two companies.
 */
router.post('/score/:origemId/:alvoId', async (req, res) => {
  try {
    const origemId = z.string().uuid().parse(req.params.origemId);
    const alvoId = z.string().uuid().parse(req.params.alvoId);
    const tipo = req.query.tipo || 'venda_direta';

    const result = await scoreOpportunity(origemId, alvoId, tipo);

    if (!result) {
      return res.status(400).json({ error: 'Não foi possível calcular score' });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'IDs inválidos', details: err.errors });
    }
    logger.error('bi_score_pair_error', { error: err.message });
    res.status(500).json({ error: 'Erro no scoring' });
  }
});

// --- Full Pipeline ---

/**
 * POST /api/bi/pipeline/:empresaId
 * Execute full BI pipeline for a company.
 * Phases: profiles → crawl → geo → taxonomy → scoring
 */
router.post('/pipeline/:empresaId', async (req, res) => {
  try {
    const { empresaId } = uuidParam.parse(req.params);
    const skipCrawl = req.query.skip_crawl === 'true';

    logger.info('bi_pipeline_start', { empresaId, skipCrawl });

    // Phase 1: Build profiles in parallel (no external deps)
    const [cnaeProfile, taxProfile] = await Promise.all([
      buildCnaeProfile(empresaId),
      buildTaxProfile(empresaId),
    ]);

    // Phase 2: Crawl website (if not skipped)
    let crawlResult = null;
    if (!skipCrawl) {
      crawlResult = await crawlCompanyWebsite(empresaId);
    }

    // Phase 3: Geo profile + Taxonomy (can run in parallel)
    const [geoProfile, taxonomy] = await Promise.all([
      buildGeoProfile(empresaId),
      classifyCompany(empresaId),
    ]);

    // Phase 4: Find CNAE-based relationships
    const cnaeRelations = await findCnaeRelationships(empresaId);

    // Phase 5: Score opportunities (if ecosystem exists)
    const opportunities = await scoreAllOpportunities(empresaId, { limit: 20 });

    logger.info('bi_pipeline_complete', {
      empresaId,
      cnae: !!cnaeProfile,
      tax: !!taxProfile,
      crawl: crawlResult?.status || 'skipped',
      geo: !!geoProfile,
      taxonomy: taxonomy?.codigo || null,
      potentialClients: cnaeRelations.clientes.length,
      potentialSuppliers: cnaeRelations.fornecedores.length,
      competitors: cnaeRelations.concorrentes.length,
      opportunities: opportunities.length,
    });

    res.json({
      success: true,
      data: {
        profiles: {
          cnae: cnaeProfile,
          tributario: taxProfile,
          geografico: geoProfile,
        },
        crawl: crawlResult,
        taxonomia: taxonomy,
        relacoes_potenciais: cnaeRelations,
        oportunidades: opportunities,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('bi_pipeline_error', {
      empresaId: sanitizeForLog(req.params.empresaId),
      error: err.message,
    });
    res.status(500).json({ error: 'Erro no pipeline BI' });
  }
});

export default router;
