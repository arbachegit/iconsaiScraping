import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';
import {
  validateQuery,
  validateParams,
  listEmendasSchema,
  searchEmendasSchema,
  integerIdParamSchema
} from '../validation/schemas.js';

const router = Router();

// Cliente Supabase para brasil-data-hub (fato_emendas_parlamentares)
const brasilDataHub = process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
  ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
  : null;

/**
 * GET /api/emendas/list
 * List emendas with pagination and optional filters
 */
router.get('/list', validateQuery(listEmendasSchema), async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({
        success: false,
        error: 'Brasil Data Hub not configured. Set BRASIL_DATA_HUB_URL and BRASIL_DATA_HUB_KEY.'
      });
    }

    // Query params already validated and transformed by Zod
    const { limit, offset, autor, uf, ano, tipo } = req.query;

    let query = brasilDataHub
      .from('fato_emendas_parlamentares')
      .select('*', { count: 'exact' })
      .order('ano', { ascending: false })
      .range(offset, offset + limit - 1);

    // All query params already validated and sanitized by Zod
    if (autor) {
      query = query.ilike('autor', `%${escapeLike(autor)}%`);
    }
    if (uf) {
      query = query.eq('uf', uf);
    }
    if (ano) {
      query = query.eq('ano', ano);
    }
    if (tipo) {
      query = query.ilike('tipo', `%${escapeLike(tipo)}%`);
    }

    const { data, error, count } = await query;

    if (error) {
      logger.error('Error listing emendas', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: count,
      emendas: data || []
    });

  } catch (error) {
    logger.error('Error listing emendas', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/emendas/search
 * Search emendas by text (autor, descricao, localidade, etc.)
 */
router.get('/search', validateQuery(searchEmendasSchema), async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({
        success: false,
        error: 'Brasil Data Hub not configured. Set BRASIL_DATA_HUB_URL and BRASIL_DATA_HUB_KEY.'
      });
    }

    // Query params already validated by Zod (q >= 2 chars, sanitized)
    const { q, limit } = req.query;

    const escaped = escapeLike(q);

    const { data, error, count } = await brasilDataHub
      .from('fato_emendas_parlamentares')
      .select('*', { count: 'exact' })
      .or(`autor.ilike.%${escaped}%,descricao.ilike.%${escaped}%,localidade.ilike.%${escaped}%`)
      .order('ano', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('Error searching emendas', { error: error.message, query: q });
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({
      success: true,
      count: data?.length || 0,
      query: q,
      emendas: data || []
    });

  } catch (error) {
    logger.error('Error searching emendas', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/emendas/:id
 * Get single emenda by ID
 */
router.get('/:id', validateParams(integerIdParamSchema), async (req, res) => {
  try {
    if (!brasilDataHub) {
      return res.status(503).json({
        success: false,
        error: 'Brasil Data Hub not configured. Set BRASIL_DATA_HUB_URL and BRASIL_DATA_HUB_KEY.'
      });
    }

    // ID already validated as integer by Zod
    const { id } = req.params;

    const { data: emenda, error } = await brasilDataHub
      .from('fato_emendas_parlamentares')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !emenda) {
      return res.status(404).json({ success: false, error: 'Emenda not found' });
    }

    res.json({
      success: true,
      emenda
    });

  } catch (error) {
    logger.error('Error getting emenda', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
