/**
 * Reports API Routes
 * Endpoints for report catalog, generation, and retrieval.
 */

import { Router } from 'express';
import { z } from 'zod';
import logger from '../utils/logger.js';
import { sanitizeForLog } from '../utils/sanitize.js';
import {
  getReportCatalog,
  getReportsForContext,
  generateReport,
  listReports,
  getReport,
} from '../services/report-engine.js';
import { computeGraphAnalytics, computeInfluenceScore } from '../services/graph-analytics.js';

const router = Router();

// ── Validation schemas ──

const uuidParam = z.object({ id: z.string().uuid() });

const generateBody = z.object({
  report_code: z.string().min(1).max(100),
  entity_type: z.string().min(1).max(50),
  entity_id: z.string().uuid(),
});

const entityParams = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
});

// ── Catalog ──

/**
 * GET /api/reports/catalog
 * List all available report templates.
 */
router.get('/catalog', async (_req, res) => {
  try {
    const catalog = await getReportCatalog();
    res.json({ success: true, data: catalog });
  } catch (err) {
    logger.error('reports_catalog_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar catálogo' });
  }
});

/**
 * GET /api/reports/catalog/context/:contextCode
 * List reports available for a specific analysis context.
 */
router.get('/catalog/context/:contextCode', async (req, res) => {
  try {
    const contextCode = req.params.contextCode;
    const reports = await getReportsForContext(contextCode);
    res.json({ success: true, data: reports });
  } catch (err) {
    logger.error('reports_context_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar relatórios por contexto' });
  }
});

// ── Generation ──

/**
 * POST /api/reports/generate
 * Generate a new report.
 */
router.post('/generate', async (req, res) => {
  try {
    const { report_code, entity_type, entity_id } = generateBody.parse(req.body);

    logger.info('report_generate_request', {
      report_code,
      entity_type,
      entity_id: sanitizeForLog(entity_id),
    });

    const result = await generateReport(report_code, entity_type, entity_id);

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Dados inválidos', details: err.errors });
    }
    logger.error('report_generate_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

// ── Retrieval ──

/**
 * GET /api/reports/entity/:entityType/:entityId
 * List generated reports for an entity.
 */
router.get('/entity/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = entityParams.parse(req.params);
    const filters = {
      status: req.query.status || undefined,
      limit: parseInt(req.query.limit) || 20,
    };

    const reports = await listReports(entityType, entityId, filters);
    res.json({ success: true, data: reports, total: reports.length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
    }
    logger.error('reports_list_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao listar relatórios' });
  }
});

/**
 * GET /api/reports/:id
 * Get a specific generated report.
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = uuidParam.parse(req.params);
    const report = await getReport(id);

    if (!report) {
      return res.status(404).json({ error: 'Relatório não encontrado' });
    }

    res.json({ success: true, data: report });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'ID inválido', details: err.errors });
    }
    logger.error('report_get_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao buscar relatório' });
  }
});

// ── Graph Analytics ──

/**
 * GET /api/reports/analytics/:entityType/:entityId
 * Compute graph analytics for an entity's network.
 */
router.get('/analytics/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = entityParams.parse(req.params);
    const hops = Math.min(parseInt(req.query.hops) || 2, 3);

    const analytics = await computeGraphAnalytics(entityType, entityId, { hops });

    if (analytics.error) {
      return res.status(400).json({ success: false, error: analytics.error });
    }

    res.json({ success: true, data: analytics });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
    }
    logger.error('graph_analytics_route_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao computar analytics' });
  }
});

/**
 * GET /api/reports/influence/:entityType/:entityId
 * Get influence score for an entity.
 */
router.get('/influence/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = entityParams.parse(req.params);
    const result = await computeInfluenceScore(entityType, entityId);
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
    }
    logger.error('influence_score_route_error', { error: err.message });
    res.status(500).json({ error: 'Erro ao calcular influência' });
  }
});

export default router;
