/**
 * Atlas Query Builder
 * Builds Supabase queries based on parsed intent for political data.
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../utils/logger.js';
import { INTENTS } from './intent-parser.js';
import { escapeLike, maskPII } from '../utils/sanitize.js';

// Brasil Data Hub client (dim_politicos, fato_politicos_mandatos)
const brasilDataHub = process.env.BRASIL_DATA_HUB_URL && process.env.BRASIL_DATA_HUB_KEY
  ? createClient(process.env.BRASIL_DATA_HUB_URL, process.env.BRASIL_DATA_HUB_KEY)
  : null;

/**
 * Check if Brasil Data Hub is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return !!brasilDataHub;
}

/**
 * Search politicians by name
 * @param {Object} entities - Parsed entities
 * @returns {Promise<Object>} - Query results
 */
async function searchPolitician(entities) {
  const { nome } = entities;

  if (!nome) {
    return { error: 'Nome do político não especificado', data: [] };
  }

  // Search in dim_politicos
  const escapedNome = escapeLike(nome);
  const { data: politicos, error } = await brasilDataHub
    .from('dim_politicos')
    .select('id, nome_completo, nome_urna, sexo, ocupacao, grau_instrucao, data_nascimento')
    .or(`nome_completo.ilike.%${escapedNome}%,nome_urna.ilike.%${escapedNome}%`)
    .limit(10);

  if (error) {
    logger.error('Error searching politicians', { error: error.message });
    return { error: error.message, data: [] };
  }

  // Enrich with latest mandato
  const enrichedPoliticians = [];
  for (const politico of politicos || []) {
    const { data: mandatos } = await brasilDataHub
      .from('fato_politicos_mandatos')
      .select('cargo, partido_sigla, partido_nome, municipio, codigo_ibge, ano_eleicao, eleito')
      .eq('politico_id', politico.id)
      .order('ano_eleicao', { ascending: false })
      .limit(3);

    enrichedPoliticians.push({
      ...politico,
      mandatos: mandatos || [],
      ultimo_mandato: mandatos?.[0] || null
    });
  }

  return {
    data: enrichedPoliticians,
    count: enrichedPoliticians.length,
    queryType: 'search_politician'
  };
}

/**
 * Get politician details by ID or name
 * @param {Object} entities - Parsed entities
 * @returns {Promise<Object>} - Query results
 */
async function getPoliticianDetails(entities) {
  const { id, nome } = entities;

  let politico = null;

  if (id) {
    const { data, error } = await brasilDataHub
      .from('dim_politicos')
      .select('id, nome_completo, nome_urna, data_nascimento, sexo, grau_instrucao, ocupacao')
      .eq('id', id)
      .single();

    if (error) {
      logger.error('Error getting politician by ID', { error: error.message, id });
      return { error: 'Político não encontrado', data: null };
    }
    politico = data;
  } else if (nome) {
    // Search and get first match
    const escapedNome = escapeLike(nome);
    const { data, error } = await brasilDataHub
      .from('dim_politicos')
      .select('id, nome_completo, nome_urna, data_nascimento, sexo, grau_instrucao, ocupacao')
      .or(`nome_completo.ilike.%${escapedNome}%,nome_urna.ilike.%${escapedNome}%`)
      .limit(1)
      .single();

    if (error || !data) {
      logger.error('Error getting politician by name', { error: error?.message, nome: maskPII(nome) });
      return { error: 'Político não encontrado', data: null };
    }
    politico = data;
  } else {
    return { error: 'ID ou nome do político não especificado', data: null };
  }

  // Get all mandates
  const { data: mandatos } = await brasilDataHub
    .from('fato_politicos_mandatos')
    .select(`
      id, cargo, partido_sigla, partido_nome, municipio, codigo_ibge,
      ano_eleicao, turno, numero_candidato, eleito, coligacao, situacao_turno,
      data_inicio_mandato, data_fim_mandato
    `)
    .eq('politico_id', politico.id)
    .order('ano_eleicao', { ascending: false });

  return {
    data: {
      politico,
      mandatos: mandatos || [],
      total_mandatos: mandatos?.length || 0,
      partidos_unicos: [...new Set(mandatos?.map(m => m.partido_sigla).filter(Boolean))]
    },
    queryType: 'politician_details'
  };
}

/**
 * Get politicians by party
 * @param {Object} entities - Parsed entities
 * @returns {Promise<Object>} - Query results
 */
async function getPoliticiansByParty(entities) {
  const { partido, cargo, ano_eleicao, eleito } = entities;

  if (!partido) {
    return { error: 'Partido não especificado', data: [] };
  }

  let query = brasilDataHub
    .from('fato_politicos_mandatos')
    .select(`
      id, cargo, partido_sigla, partido_nome, municipio, codigo_ibge,
      ano_eleicao, eleito, situacao_turno,
      politico:politico_id (id, nome_completo, nome_urna, sexo, ocupacao)
    `)
    .eq('partido_sigla', partido.toUpperCase())
    .limit(50);

  if (cargo) {
    query = query.ilike('cargo', `%${escapeLike(cargo)}%`);
  }
  if (ano_eleicao) {
    query = query.eq('ano_eleicao', ano_eleicao);
  }
  if (eleito !== undefined && eleito !== null) {
    query = query.eq('eleito', eleito);
  }

  const { data, error, count } = await query.order('ano_eleicao', { ascending: false });

  if (error) {
    logger.error('Error getting politicians by party', { error: error.message, partido });
    return { error: error.message, data: [] };
  }

  // Flatten and deduplicate
  const seen = new Set();
  const politicians = [];
  for (const mandato of data || []) {
    const politico = mandato.politico || {};
    const politicoId = politico.id;
    if (politicoId && !seen.has(politicoId)) {
      seen.add(politicoId);
      politicians.push({
        id: politicoId,
        nome_completo: politico.nome_completo,
        nome_urna: politico.nome_urna,
        sexo: politico.sexo,
        cargo: mandato.cargo,
        municipio: mandato.municipio,
        ano_eleicao: mandato.ano_eleicao,
        eleito: mandato.eleito
      });
    }
  }

  return {
    data: politicians,
    count: politicians.length,
    partido,
    queryType: 'by_party'
  };
}

/**
 * Get politicians by municipality
 * @param {Object} entities - Parsed entities
 * @returns {Promise<Object>} - Query results
 */
async function getPoliticiansByMunicipality(entities) {
  const { municipio, codigo_ibge, cargo, ano_eleicao, eleito } = entities;

  if (!municipio && !codigo_ibge) {
    return { error: 'Município não especificado', data: [] };
  }

  let query = brasilDataHub
    .from('fato_politicos_mandatos')
    .select(`
      id, cargo, partido_sigla, municipio, codigo_ibge,
      ano_eleicao, eleito, situacao_turno,
      politico:politico_id (id, nome_completo, nome_urna, sexo)
    `)
    .limit(100);

  if (codigo_ibge) {
    query = query.eq('codigo_ibge', codigo_ibge);
  } else if (municipio) {
    query = query.ilike('municipio', `%${escapeLike(municipio)}%`);
  }

  if (cargo) {
    query = query.ilike('cargo', `%${escapeLike(cargo)}%`);
  }
  if (ano_eleicao) {
    query = query.eq('ano_eleicao', ano_eleicao);
  }
  if (eleito !== undefined && eleito !== null) {
    query = query.eq('eleito', eleito);
  }

  const { data, error } = await query.order('cargo');

  if (error) {
    logger.error('Error getting politicians by municipality', { error: error.message, municipio });
    return { error: error.message, data: [] };
  }

  // Flatten data
  const politicians = (data || []).map(mandato => ({
    id: mandato.politico?.id,
    nome_completo: mandato.politico?.nome_completo,
    nome_urna: mandato.politico?.nome_urna,
    sexo: mandato.politico?.sexo,
    cargo: mandato.cargo,
    partido_sigla: mandato.partido_sigla,
    municipio: mandato.municipio,
    codigo_ibge: mandato.codigo_ibge,
    ano_eleicao: mandato.ano_eleicao,
    eleito: mandato.eleito
  }));

  return {
    data: politicians,
    count: politicians.length,
    municipio: municipio || codigo_ibge,
    queryType: 'by_municipality'
  };
}

/**
 * Get statistics about politicians/parties
 * @param {Object} entities - Parsed entities
 * @returns {Promise<Object>} - Query results
 */
async function getStatistics(entities) {
  const { partido, cargo, municipio, ano_eleicao } = entities;

  // Build base query
  let query = brasilDataHub
    .from('fato_politicos_mandatos')
    .select('partido_sigla, cargo, eleito, ano_eleicao, codigo_ibge', { count: 'exact' });

  if (partido) {
    query = query.eq('partido_sigla', partido.toUpperCase());
  }
  if (cargo) {
    query = query.ilike('cargo', `%${escapeLike(cargo)}%`);
  }
  if (municipio) {
    query = query.ilike('municipio', `%${escapeLike(municipio)}%`);
  }
  if (ano_eleicao) {
    query = query.eq('ano_eleicao', ano_eleicao);
  }

  const { data, error, count } = await query;

  if (error) {
    logger.error('Error getting statistics', { error: error.message });
    return { error: error.message, data: {} };
  }

  // Calculate statistics
  const stats = {
    total_mandatos: count,
    total_eleitos: data?.filter(m => m.eleito === true).length || 0,
    por_partido: {},
    por_cargo: {},
    por_ano: {}
  };

  for (const mandato of data || []) {
    // By party
    const p = mandato.partido_sigla || 'SEM PARTIDO';
    stats.por_partido[p] = (stats.por_partido[p] || 0) + 1;

    // By position
    const c = mandato.cargo || 'OUTRO';
    stats.por_cargo[c] = (stats.por_cargo[c] || 0) + 1;

    // By year
    const y = mandato.ano_eleicao;
    if (y) {
      stats.por_ano[y] = (stats.por_ano[y] || 0) + 1;
    }
  }

  // Sort parties by count
  stats.partidos_ordenados = Object.entries(stats.por_partido)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return {
    data: stats,
    queryType: 'statistics'
  };
}

/**
 * List all parties with counts
 * @returns {Promise<Object>} - Query results
 */
async function listParties() {
  const { data, error } = await brasilDataHub
    .from('fato_politicos_mandatos')
    .select('partido_sigla, partido_nome')
    .not('partido_sigla', 'is', null);

  if (error) {
    logger.error('Error listing parties', { error: error.message });
    return { error: error.message, data: [] };
  }

  // Count by party
  const partyCounts = {};
  const partyNames = {};
  for (const row of data || []) {
    const sigla = row.partido_sigla;
    partyCounts[sigla] = (partyCounts[sigla] || 0) + 1;
    if (row.partido_nome) {
      partyNames[sigla] = row.partido_nome;
    }
  }

  // Convert to array and sort
  const parties = Object.entries(partyCounts)
    .map(([sigla, count]) => ({
      sigla,
      nome: partyNames[sigla] || sigla,
      count
    }))
    .sort((a, b) => b.count - a.count);

  return {
    data: parties,
    count: parties.length,
    queryType: 'party_list'
  };
}

/**
 * Execute query based on intent
 * @param {Object} parsedIntent - Result from intent parser
 * @returns {Promise<Object>} - Query results
 */
export async function executeQuery(parsedIntent) {
  const startTime = Date.now();
  const { intent, entities } = parsedIntent;

  if (!brasilDataHub) {
    return {
      error: 'Brasil Data Hub não configurado. Configure BRASIL_DATA_HUB_URL e BRASIL_DATA_HUB_KEY.',
      data: null
    };
  }

  let result;

  switch (intent) {
    case INTENTS.SEARCH_POLITICIAN:
      result = await searchPolitician(entities);
      break;

    case INTENTS.POLITICIAN_DETAILS:
      result = await getPoliticianDetails(entities);
      break;

    case INTENTS.BY_PARTY:
      result = await getPoliticiansByParty(entities);
      break;

    case INTENTS.BY_MUNICIPALITY:
      result = await getPoliticiansByMunicipality(entities);
      break;

    case INTENTS.STATISTICS:
      result = await getStatistics(entities);
      break;

    case INTENTS.PARTY_LIST:
      result = await listParties();
      break;

    case INTENTS.FOLLOW_UP:
      // Re-execute with merged entities from context
      // The orchestrator should have merged the entities already
      if (entities.id || entities.nome) {
        result = await getPoliticianDetails(entities);
      } else if (entities.partido) {
        result = await getPoliticiansByParty(entities);
      } else if (entities.municipio) {
        result = await getPoliticiansByMunicipality(entities);
      } else {
        result = await getStatistics(entities);
      }
      break;

    case INTENTS.GENERAL:
    default:
      // Try to infer from entities
      if (entities.nome) {
        result = await searchPolitician(entities);
      } else if (entities.partido) {
        result = await getPoliticiansByParty(entities);
      } else if (entities.municipio) {
        result = await getPoliticiansByMunicipality(entities);
      } else {
        result = await listParties();
      }
      break;
  }

  const processingTime = Date.now() - startTime;
  logger.debug('Query executed', {
    intent,
    queryType: result.queryType,
    resultCount: Array.isArray(result.data) ? result.data.length : 1,
    processingTime
  });

  return {
    ...result,
    processingTime
  };
}

export default {
  executeQuery,
  isConfigured
};
