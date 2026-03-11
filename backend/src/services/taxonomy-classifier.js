/**
 * Taxonomy Classifier Service
 * Classifies companies into the dim_taxonomia_empresa hierarchy.
 * Uses CNAE codes + keywords from website crawl data to find the best match.
 */

import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { sanitizeUUID } from '../utils/sanitize.js';

/** @type {Map<string, Object>|null} Cached taxonomy tree */
let taxonomyCache = null;
let taxonomyCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load taxonomy tree into memory.
 * @returns {Promise<Map<string, Object>>}
 */
async function loadTaxonomy() {
  if (taxonomyCache && Date.now() - taxonomyCacheTime < CACHE_TTL) {
    return taxonomyCache;
  }

  const { data, error } = await supabase
    .from('dim_taxonomia_empresa')
    .select('*')
    .eq('ativo', true)
    .order('nivel', { ascending: true });

  if (error || !data) {
    logger.error('taxonomy_load_error', { error: error?.message });
    return taxonomyCache || new Map();
  }

  const map = new Map();
  for (const item of data) {
    map.set(item.codigo, item);
  }

  taxonomyCache = map;
  taxonomyCacheTime = Date.now();

  logger.debug('taxonomy_loaded', { count: map.size });
  return map;
}

/**
 * Classify a company by its CNAE and keywords.
 *
 * @param {string} empresaId - Company UUID
 * @returns {Promise<Object|null>} Best matching taxonomy entry or null
 */
export async function classifyCompany(empresaId) {
  const id = sanitizeUUID(empresaId);
  if (!id) return null;

  try {
    // Fetch company data
    const { data: empresa, error } = await supabase
      .from('dim_empresas')
      .select('id, cnae_principal, cnaes_secundarios, razao_social, nome_fantasia')
      .eq('id', id)
      .single();

    if (error || !empresa) {
      logger.warn('taxonomy_classify_empresa_not_found', { empresaId: id });
      return null;
    }

    // Also fetch crawl data for keywords
    const { data: crawl } = await supabase
      .from('fato_website_crawl')
      .select('palavras_chave, segmento_detectado, resumo_atividade')
      .eq('empresa_id', id)
      .eq('status', 'sucesso')
      .order('updated_at', { ascending: false })
      .limit(1);

    const keywords = crawl?.[0]?.palavras_chave || [];
    const segmento = crawl?.[0]?.segmento_detectado || '';

    const taxonomy = await loadTaxonomy();
    if (taxonomy.size === 0) return null;

    const cnaeDivision = getCnaeDivision(empresa.cnae_principal);

    // Step 1: Match by CNAE (most reliable)
    let bestMatch = null;
    let bestScore = 0;

    for (const [, entry] of taxonomy) {
      let score = 0;

      // CNAE match
      if (entry.cnaes_relacionados?.includes(cnaeDivision)) {
        score += entry.nivel === 2 ? 10 : 5; // Prefer segment (level 2) over sector (level 1)
      }

      // Keyword match
      if (entry.palavras_chave?.length > 0 && keywords.length > 0) {
        const keywordHits = entry.palavras_chave.filter((kw) =>
          keywords.some((k) => k.toLowerCase().includes(kw.toLowerCase()))
        ).length;
        score += keywordHits * 3;
      }

      // Name/segment match
      if (entry.palavras_chave?.length > 0) {
        const nameText = `${empresa.razao_social || ''} ${empresa.nome_fantasia || ''} ${segmento}`.toLowerCase();
        const nameHits = entry.palavras_chave.filter((kw) =>
          nameText.includes(kw.toLowerCase())
        ).length;
        score += nameHits * 2;
      }

      // Synonym match
      if (entry.sinonimos?.length > 0) {
        const nameText = `${empresa.razao_social || ''} ${empresa.nome_fantasia || ''} ${segmento}`.toLowerCase();
        const synHits = entry.sinonimos.filter((s) =>
          nameText.includes(s.toLowerCase())
        ).length;
        score += synHits * 2;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    if (!bestMatch) {
      logger.info('taxonomy_no_match', { empresaId: id, cnae: empresa.cnae_principal });
      return null;
    }

    // Update company with taxonomy reference (add taxonomia_id to dim_empresas if exists)
    // For now, store in website crawl or return for pipeline use
    logger.info('taxonomy_classified', {
      empresaId: id,
      codigo: bestMatch.codigo,
      nome: bestMatch.nome,
      nivel: bestMatch.nivel,
      score: bestScore,
    });

    return bestMatch;
  } catch (err) {
    logger.error('taxonomy_classify_error', { empresaId: id, error: err.message });
    return null;
  }
}

/**
 * Classify all companies that don't have a taxonomy yet.
 *
 * @param {number} [batchSize=100] - Companies per batch
 * @returns {Promise<{ classified: number, failed: number }>}
 */
export async function classifyAllUnclassified(batchSize = 100) {
  let classified = 0;
  let failed = 0;
  let offset = 0;

  while (true) {
    const { data: empresas, error } = await supabase
      .from('dim_empresas')
      .select('id')
      .not('cnae_principal', 'is', null)
      .range(offset, offset + batchSize - 1);

    if (error || !empresas?.length) break;

    for (const empresa of empresas) {
      const result = await classifyCompany(empresa.id);
      if (result) classified++;
      else failed++;
    }

    offset += batchSize;

    if (empresas.length < batchSize) break;
  }

  logger.info('taxonomy_batch_complete', { classified, failed });
  return { classified, failed };
}

/**
 * Get 2-digit CNAE division.
 * @param {string} cnae
 * @returns {string}
 */
function getCnaeDivision(cnae) {
  if (!cnae) return '';
  return cnae.replace(/[^\d]/g, '').substring(0, 2);
}

/**
 * Invalidate taxonomy cache (call after updates to dim_taxonomia_empresa).
 */
export function invalidateCache() {
  taxonomyCache = null;
  taxonomyCacheTime = 0;
}
