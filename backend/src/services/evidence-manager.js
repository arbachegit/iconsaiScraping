/**
 * Evidence Manager Service
 * Centralized CRUD for the fato_evidencias table.
 * All evidence in the system flows through here.
 */

import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { sanitizeUUID, sanitizeForLog } from '../utils/sanitize.js';

/**
 * Create a new evidence record.
 *
 * @param {Object} evidence
 * @param {string} evidence.entidade_origem_type - Entity type (empresa, pessoa, politico, etc.)
 * @param {string} evidence.entidade_origem_id - Origin entity UUID
 * @param {string} [evidence.entidade_destino_type] - Destination entity type
 * @param {string} [evidence.entidade_destino_id] - Destination entity UUID
 * @param {string} evidence.tipo_evidencia - Evidence type
 * @param {string} evidence.fonte - Source of the evidence
 * @param {number} [evidence.confianca=0.5] - Confidence 0-1
 * @param {string} [evidence.metodo_extracao] - Extraction method
 * @param {string} [evidence.texto_evidencia] - Supporting text
 * @param {Object} [evidence.metadata] - Extra metadata
 * @param {string} [evidence.expires_at] - Expiration timestamp
 * @returns {Promise<Object|null>} Created evidence or null
 */
export async function createEvidence(evidence) {
  const originId = sanitizeUUID(evidence.entidade_origem_id);
  if (!originId) {
    logger.warn('evidence_create_invalid_origin_id', {
      id: sanitizeForLog(String(evidence.entidade_origem_id || '')),
    });
    return null;
  }

  const destId = evidence.entidade_destino_id
    ? sanitizeUUID(evidence.entidade_destino_id)
    : null;

  const record = {
    entidade_origem_type: evidence.entidade_origem_type,
    entidade_origem_id: originId,
    entidade_destino_type: evidence.entidade_destino_type || null,
    entidade_destino_id: destId,
    tipo_evidencia: evidence.tipo_evidencia,
    fonte: evidence.fonte,
    confianca: Math.max(0, Math.min(1, evidence.confianca ?? 0.5)),
    metodo_extracao: evidence.metodo_extracao || null,
    texto_evidencia: evidence.texto_evidencia || null,
    metadata: evidence.metadata || null,
    expires_at: evidence.expires_at || null,
  };

  const { data, error } = await supabase
    .from('fato_evidencias')
    .insert(record)
    .select()
    .single();

  if (error) {
    logger.error('evidence_create_error', {
      tipo: record.tipo_evidencia,
      fonte: record.fonte,
      error: error.message,
    });
    return null;
  }

  logger.info('evidence_created', {
    id: data.id,
    tipo: data.tipo_evidencia,
    fonte: data.fonte,
    confianca: data.confianca,
  });

  return data;
}

/**
 * Create multiple evidence records in batch.
 *
 * @param {Array<Object>} evidences - Array of evidence objects
 * @returns {Promise<Array<Object>>} Created records
 */
export async function createEvidenceBatch(evidences) {
  if (!evidences?.length) return [];

  const records = evidences
    .map((e) => {
      const originId = sanitizeUUID(e.entidade_origem_id);
      if (!originId) return null;

      return {
        entidade_origem_type: e.entidade_origem_type,
        entidade_origem_id: originId,
        entidade_destino_type: e.entidade_destino_type || null,
        entidade_destino_id: e.entidade_destino_id
          ? sanitizeUUID(e.entidade_destino_id)
          : null,
        tipo_evidencia: e.tipo_evidencia,
        fonte: e.fonte,
        confianca: Math.max(0, Math.min(1, e.confianca ?? 0.5)),
        metodo_extracao: e.metodo_extracao || null,
        texto_evidencia: e.texto_evidencia || null,
        metadata: e.metadata || null,
        expires_at: e.expires_at || null,
      };
    })
    .filter(Boolean);

  if (!records.length) return [];

  const { data, error } = await supabase
    .from('fato_evidencias')
    .insert(records)
    .select();

  if (error) {
    logger.error('evidence_batch_create_error', {
      count: records.length,
      error: error.message,
    });
    return [];
  }

  logger.info('evidence_batch_created', { count: data.length });
  return data;
}

/**
 * Get all evidence for an entity.
 *
 * @param {string} entityType - Entity type
 * @param {string} entityId - Entity UUID
 * @param {Object} [filters={}]
 * @param {string} [filters.tipo_evidencia] - Filter by evidence type
 * @param {string} [filters.fonte] - Filter by source
 * @param {number} [filters.min_confianca] - Minimum confidence
 * @param {number} [filters.limit=100] - Max results
 * @returns {Promise<Array<Object>>}
 */
export async function getEvidenceForEntity(entityType, entityId, filters = {}) {
  const id = sanitizeUUID(entityId);
  if (!id) return [];

  let query = supabase
    .from('fato_evidencias')
    .select('*')
    .eq('ativo', true)
    .or(
      `and(entidade_origem_type.eq.${entityType},entidade_origem_id.eq.${id}),and(entidade_destino_type.eq.${entityType},entidade_destino_id.eq.${id})`
    );

  if (filters.tipo_evidencia) {
    query = query.eq('tipo_evidencia', filters.tipo_evidencia);
  }
  if (filters.fonte) {
    query = query.eq('fonte', filters.fonte);
  }
  if (filters.min_confianca) {
    query = query.gte('confianca', filters.min_confianca);
  }

  const limit = Math.min(filters.limit || 100, 500);

  const { data, error } = await query
    .order('confianca', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('evidence_get_error', {
      entityType,
      entityId: id,
      error: error.message,
    });
    return [];
  }

  return data || [];
}

/**
 * Get evidence between two entities.
 *
 * @param {string} originType
 * @param {string} originId
 * @param {string} destType
 * @param {string} destId
 * @returns {Promise<Array<Object>>}
 */
export async function getEvidenceBetween(originType, originId, destType, destId) {
  const oId = sanitizeUUID(originId);
  const dId = sanitizeUUID(destId);
  if (!oId || !dId) return [];

  const { data, error } = await supabase
    .from('fato_evidencias')
    .select('*')
    .eq('ativo', true)
    .or(
      `and(entidade_origem_type.eq.${originType},entidade_origem_id.eq.${oId},entidade_destino_type.eq.${destType},entidade_destino_id.eq.${dId}),and(entidade_origem_type.eq.${destType},entidade_origem_id.eq.${dId},entidade_destino_type.eq.${originType},entidade_destino_id.eq.${oId})`
    )
    .order('confianca', { ascending: false });

  if (error) {
    logger.error('evidence_between_error', { error: error.message });
    return [];
  }

  return data || [];
}

/**
 * Compute aggregate confidence from multiple evidence records.
 * Uses Bayesian combination: P(A∪B) = 1 - (1-P(A)) * (1-P(B))
 *
 * @param {Array<Object>} evidences - Evidence records with confianca field
 * @returns {number} Combined confidence 0-1
 */
export function combineConfidence(evidences) {
  if (!evidences?.length) return 0;

  const confidences = evidences.map((e) => e.confianca || 0);
  const combinedUncertainty = confidences.reduce(
    (acc, c) => acc * (1 - c),
    1
  );

  return Math.round((1 - combinedUncertainty) * 100) / 100;
}

/**
 * Deactivate expired evidence records.
 *
 * @returns {Promise<number>} Number of deactivated records
 */
export async function deactivateExpired() {
  const { data, error } = await supabase
    .from('fato_evidencias')
    .update({ ativo: false, updated_at: new Date().toISOString() })
    .eq('ativo', true)
    .lt('expires_at', new Date().toISOString())
    .select('id');

  if (error) {
    logger.error('evidence_deactivate_expired_error', { error: error.message });
    return 0;
  }

  const count = data?.length || 0;
  if (count > 0) {
    logger.info('evidence_expired_deactivated', { count });
  }
  return count;
}
