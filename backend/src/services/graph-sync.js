/**
 * Graph Sync Service
 * Detects empresas without graph relationships and enriches them.
 * Called alongside stats/snapshot to keep the graph in sync with the DB.
 *
 * Strategy:
 * 1. Find empresas added since last sync that have NO relationships in fato_relacoes_entidades
 * 2. For each, run the graph pipeline (socios, CNAE, geo, news)
 * 3. Track last sync timestamp to avoid re-processing
 *
 * Rate-limited: processes max BATCH_SIZE empresas per sync cycle to avoid overload.
 */

import { supabase } from '../database/supabase.js';
import { ensureCompanyGraphMaterialized } from './graph-materialization.js';
import logger from '../utils/logger.js';

const BATCH_SIZE = 10; // Max empresas to process per sync cycle
const SYNC_KEY = 'graph_sync_last_run';

/**
 * Get last sync timestamp from a simple key-value approach.
 * Uses supabase RPC or a config table. Falls back to 24h ago.
 */
async function getLastSyncTime() {
  try {
    const { data } = await supabase
      .from('config_kv')
      .select('value')
      .eq('key', SYNC_KEY)
      .maybeSingle();

    if (data?.value) {
      return data.value;
    }
  } catch {
    // Table may not exist yet — that's OK
  }

  // Default: 24 hours ago
  const d = new Date();
  d.setHours(d.getHours() - 24);
  return d.toISOString();
}

/**
 * Save last sync timestamp.
 */
async function setLastSyncTime(timestamp) {
  try {
    await supabase
      .from('config_kv')
      .upsert({ key: SYNC_KEY, value: timestamp }, { onConflict: 'key' });
  } catch {
    // Non-critical — next sync will just re-check
  }
}

/**
 * Find empresas created after `since` that have no relationships.
 */
async function findUnlinkedEmpresas(since, limit) {
  // Get recently created empresas
  const { data: recent, error } = await supabase
    .from('dim_empresas')
    .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, cnae_descricao')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(limit * 2); // Fetch extra since some may already have edges

  if (error || !recent || recent.length === 0) return [];

  // Check which ones already have relationships
  const ids = recent.map(e => String(e.id));

  const { data: existingEdges } = await supabase
    .from('fato_relacoes_entidades')
    .select('source_id, target_id')
    .eq('ativo', true)
    .or(
      `and(source_type.eq.empresa,source_id.in.(${ids.join(',')})),and(target_type.eq.empresa,target_id.in.(${ids.join(',')}))`
    );

  const linkedIds = new Set();
  for (const edge of (existingEdges || [])) {
    linkedIds.add(String(edge.source_id));
    linkedIds.add(String(edge.target_id));
  }

  // Return only unlinked empresas
  return recent
    .filter(e => !linkedIds.has(String(e.id)))
    .slice(0, limit);
}

/**
 * Run graph sync: find unlinked empresas and enrich their relationships.
 *
 * @returns {Object} Summary { processed, total_relationships, skipped, errors }
 */
export async function syncGraphRelationships() {
  const startTime = Date.now();
  const since = await getLastSyncTime();

  logger.info('graph_sync_start', { since, batch_size: BATCH_SIZE });

  const unlinked = await findUnlinkedEmpresas(since, BATCH_SIZE);

  if (unlinked.length === 0) {
    logger.info('graph_sync_no_new', { since });
    await setLastSyncTime(new Date().toISOString());
    return { processed: 0, total_relationships: 0, skipped: 0, errors: 0, duration_ms: Date.now() - startTime };
  }

  let processed = 0;
  let totalRels = 0;
  let errors = 0;

  for (const empresa of unlinked) {
    try {
      const result = await ensureCompanyGraphMaterialized(empresa.id, { force: true });

      totalRels += result.materialized.total;
      processed++;

      logger.info('graph_sync_empresa', {
        empresa_id: empresa.id,
        nome: empresa.nome_fantasia || empresa.razao_social,
        relationships: result.materialized.total,
        societaria: result.materialized.societaria,
        cnae_similar: result.materialized.cnae_similar,
        geografico: result.materialized.geografico,
        mencionado_em: result.materialized.mencionado_em,
        emenda_beneficiario: result.materialized.emenda_beneficiario,
        politico_empresarial: result.materialized.politico_empresarial,
        mandatos: result.materialized.mandatos,
      });
    } catch (err) {
      errors++;
      logger.error('graph_sync_empresa_error', {
        empresa_id: empresa.id,
        error: err.message,
      });
    }
  }

  await setLastSyncTime(new Date().toISOString());

  const duration = Date.now() - startTime;
  logger.info('graph_sync_complete', {
    processed,
    total_relationships: totalRels,
    errors,
    duration_ms: duration,
  });

  return {
    processed,
    total_relationships: totalRels,
    skipped: unlinked.length - processed,
    errors,
    duration_ms: duration,
  };
}
