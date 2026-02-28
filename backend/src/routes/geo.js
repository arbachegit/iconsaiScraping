/**
 * Geographic data routes - MCP Brasil Data Hub
 *
 * Endpoints para buscar dados geograficos do brasil-data-hub:
 * - GET /geo/municipios/:codigoIbge - Buscar municipio por codigo IBGE
 * - GET /geo/municipios/search - Buscar municipio por nome e UF
 * - GET /geo/capitais - Listar capitais brasileiras
 * - GET /geo/estados - Listar estados
 * - GET /geo/estados/:sigla - Buscar estado por sigla
 */

import express from 'express';
import { z } from 'zod';
import brasilDataHub from '../services/brasil-data-hub.js';
import logger from '../utils/logger.js';
import { sendError } from '../utils/response.js';

const router = express.Router();

// ===========================================
// SCHEMAS DE VALIDAÇÃO
// ===========================================

const codigoIbgeSchema = z.string().regex(/^\d{7}$/, 'Código IBGE deve ter 7 dígitos');
const ufSchema = z.string().length(2, 'UF deve ter 2 caracteres').toUpperCase();
const regiaoSchema = z.enum(['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul']).optional();

// ===========================================
// ROTAS DE MUNICÍPIOS
// ===========================================

/**
 * GET /geo/municipios/:codigoIbge
 * Busca municipio por codigo IBGE
 */
router.get('/municipios/:codigoIbge', async (req, res) => {
  try {
    const codigoIbge = codigoIbgeSchema.parse(req.params.codigoIbge);

    const municipio = await brasilDataHub.getMunicipioByCodigo(codigoIbge);

    if (!municipio) {
      return sendError(res, 404, 'Município não encontrado');
    }

    res.json(municipio);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, 400, error.errors[0].message);
    }
    logger.error('Erro ao buscar municipio', { error: error.message });
    sendError(res, 500, 'Erro interno');
  }
});

/**
 * GET /geo/municipios/search?nome=...&uf=...
 * Busca municipio por nome e UF
 */
router.get('/municipios/search', async (req, res) => {
  try {
    const nome = req.query.nome;
    const uf = ufSchema.parse(req.query.uf);

    if (!nome) {
      return sendError(res, 400, 'Parâmetro nome é obrigatório');
    }

    const municipio = await brasilDataHub.getMunicipioByNome(nome, uf);

    if (!municipio) {
      return sendError(res, 404, 'Município não encontrado');
    }

    res.json(municipio);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, 400, error.errors[0].message);
    }
    logger.error('Erro ao buscar municipio por nome', { error: error.message });
    sendError(res, 500, 'Erro interno');
  }
});

/**
 * GET /geo/municipios?uf=...
 * Lista municipios por UF
 */
router.get('/municipios', async (req, res) => {
  try {
    const uf = req.query.uf ? ufSchema.parse(req.query.uf) : null;

    if (!uf) {
      return sendError(res, 400, 'Parâmetro uf é obrigatório');
    }

    const municipios = await brasilDataHub.getMunicipiosByUf(uf);

    res.json({
      uf,
      total: municipios.length,
      municipios
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, 400, error.errors[0].message);
    }
    logger.error('Erro ao listar municipios', { error: error.message });
    sendError(res, 500, 'Erro interno');
  }
});

// ===========================================
// ROTAS DE CAPITAIS
// ===========================================

/**
 * GET /geo/capitais?regiao=...
 * Lista capitais brasileiras (opcionalmente filtradas por região)
 */
router.get('/capitais', async (req, res) => {
  try {
    const regiao = req.query.regiao ? regiaoSchema.parse(req.query.regiao) : null;

    const capitais = await brasilDataHub.getCapitais(regiao);

    res.json({
      regiao: regiao || 'todas',
      total: capitais.length,
      capitais
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, 400, error.errors[0].message);
    }
    logger.error('Erro ao listar capitais', { error: error.message });
    sendError(res, 500, 'Erro interno');
  }
});

// ===========================================
// ROTAS DE ESTADOS
// ===========================================

/**
 * GET /geo/estados?regiao=...
 * Lista todos os estados (opcionalmente filtrados por região)
 */
router.get('/estados', async (req, res) => {
  try {
    const regiao = req.query.regiao ? regiaoSchema.parse(req.query.regiao) : null;

    const estados = await brasilDataHub.getEstados(regiao);

    res.json({
      regiao: regiao || 'todas',
      total: estados.length,
      estados
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, 400, error.errors[0].message);
    }
    logger.error('Erro ao listar estados', { error: error.message });
    sendError(res, 500, 'Erro interno');
  }
});

/**
 * GET /geo/estados/:sigla
 * Busca estado por sigla (UF)
 */
router.get('/estados/:sigla', async (req, res) => {
  try {
    const sigla = ufSchema.parse(req.params.sigla);

    const estado = await brasilDataHub.getEstadoBySigla(sigla);

    if (!estado) {
      return sendError(res, 404, 'Estado não encontrado');
    }

    res.json(estado);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return sendError(res, 400, error.errors[0].message);
    }
    logger.error('Erro ao buscar estado', { error: error.message });
    sendError(res, 500, 'Erro interno');
  }
});

// ===========================================
// ROTA DE RESOLUÇÃO
// ===========================================

/**
 * POST /geo/resolve
 * Resolve codigo IBGE a partir de cidade e estado
 * Body: { cidade: string, estado: string }
 */
router.post('/resolve', async (req, res) => {
  try {
    const { cidade, estado } = req.body;

    if (!cidade || !estado) {
      return sendError(res, 400, 'cidade e estado são obrigatórios');
    }

    const codigoIbge = await brasilDataHub.resolveCodigoIbge(cidade, estado);

    if (!codigoIbge) {
      return sendError(res, 404, 'Município não encontrado');
    }

    res.json({
      cidade,
      estado,
      codigo_ibge: codigoIbge
    });
  } catch (error) {
    logger.error('Erro ao resolver codigo IBGE', { error: error.message });
    sendError(res, 500, 'Erro interno');
  }
});

export default router;
