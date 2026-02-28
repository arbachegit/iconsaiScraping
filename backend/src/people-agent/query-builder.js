/**
 * People Agent - Query Builder
 * Executes parallel queries across multiple sources using Promise.allSettled.
 * Merges results into a unified person profile.
 */

import logger from '../utils/logger.js';
import { supabase } from '../database/supabase.js';
import { INTENTS } from './intent-parser.js';
import { escapeLike, maskPII } from '../utils/sanitize.js';

// Import existing services
import * as apolloService from '../services/apollo.js';
import * as perplexityService from '../services/perplexity.js';
import * as serperService from '../services/serper.js';
import { runGuardrail } from '../services/people-guardrail.js';

/**
 * Intent → data sources mapping
 */
const SOURCE_MAP = {
  [INTENTS.SEARCH_PERSON]: ['db', 'serper'],
  [INTENTS.PERSON_DETAILS]: ['db', 'apollo', 'perplexity', 'serper'],
  [INTENTS.PERSON_PROFESSIONAL]: ['db', 'apollo', 'perplexity'],
  [INTENTS.PERSON_ACADEMIC]: ['perplexity'],
  [INTENTS.PERSON_SOCIAL]: ['apollo', 'serper'],
  [INTENTS.PERSON_REPUTATION]: ['perplexity'],
  [INTENTS.PERSON_CONNECTIONS]: ['db'],
  [INTENTS.FOLLOW_UP]: ['db', 'apollo', 'perplexity', 'serper'],
  [INTENTS.GENERAL]: ['db']
};

/**
 * Query the local database for person data
 */
async function queryDatabase(entities) {
  const results = { persons: [], connections: [] };

  // Search by CPF
  if (entities.cpf) {
    const { data } = await supabase
      .from('dim_pessoas')
      .select('*')
      .eq('cpf', entities.cpf)
      .limit(5);

    if (data?.length) {
      results.persons = data;
    }
  }

  // Search by name
  if (entities.nome && results.persons.length === 0) {
    const { data } = await supabase
      .from('dim_pessoas')
      .select('*')
      .ilike('nome_completo', `%${escapeLike(entities.nome)}%`)
      .limit(10);

    if (data?.length) {
      results.persons = data;
    }
  }

  // Get connections (empresa relationships) if we have person matches
  if (results.persons.length > 0) {
    const personIds = results.persons.map(p => p.id).filter(Boolean);
    if (personIds.length > 0) {
      const { data: connections } = await supabase
        .from('fato_transacao_empresas')
        .select(`
          cargo,
          qualificacao,
          data_entrada,
          ativo,
          dim_empresas (
            id,
            razao_social,
            nome_fantasia,
            cnpj,
            cidade,
            estado,
            cnae_descricao
          )
        `)
        .in('pessoa_id', personIds)
        .limit(20);

      if (connections?.length) {
        results.connections = connections;
      }
    }
  }

  return results;
}

/**
 * Query Apollo for person data
 */
async function queryApollo(entities) {
  if (!entities.nome) return null;

  try {
    const result = await apolloService.searchPerson(
      entities.nome,
      entities.empresa || null
    );
    return result;
  } catch (error) {
    logger.warn('Apollo query failed', { error: error.message, name: maskPII(entities.nome) });
    return null;
  }
}

/**
 * Query Perplexity for person data
 */
async function queryPerplexity(entities) {
  if (!entities.nome) return null;

  try {
    const result = await perplexityService.searchPerson(
      entities.nome,
      entities.cpf || null
    );
    return result;
  } catch (error) {
    logger.warn('Perplexity query failed', { error: error.message, name: maskPII(entities.nome) });
    return null;
  }
}

/**
 * Query Serper (Google) for person data
 */
async function querySerper(entities) {
  if (!entities.nome) return null;

  const results = { linkedin: null, general: null };

  try {
    // Try LinkedIn search
    const linkedinResult = await serperService.findPersonLinkedin(
      entities.nome,
      entities.empresa || null
    );
    if (linkedinResult) {
      results.linkedin = linkedinResult;
    }
  } catch (error) {
    logger.warn('Serper LinkedIn query failed', { error: error.message });
  }

  try {
    // General search for additional context
    const query = entities.empresa
      ? `"${entities.nome}" "${entities.empresa}"`
      : `"${entities.nome}"`;
    const generalResult = await serperService.search(query, 5);
    if (generalResult) {
      results.general = generalResult;
    }
  } catch (error) {
    logger.warn('Serper general query failed', { error: error.message });
  }

  return results;
}

/**
 * Merge results from multiple sources into a unified profile
 * Priority: DB > Perplexity > Apollo > Serper (for identity)
 * Priority: Apollo > Perplexity > DB (for professional)
 * Priority: Apollo > Serper > DB (for LinkedIn)
 */
function mergePersonProfile(dbResult, apolloResult, perplexityResult, serperResult) {
  const profile = {
    // Identity
    id: null,
    nome_completo: null,
    cpf: null,
    email: null,
    foto_url: null,

    // Professional
    cargo_atual: null,
    empresa_atual: null,
    headline: null,
    resumo_profissional: null,

    // Social
    linkedin_url: null,
    github_url: null,

    // Location
    localizacao: null,
    cidade: null,
    estado: null,

    // Connections
    empresas: [],

    // Meta
    sources_used: []
  };

  // DB data (highest priority for identity)
  if (dbResult?.persons?.length > 0) {
    const person = dbResult.persons[0];
    profile.id = person.id;
    profile.nome_completo = person.nome_completo || person.primeiro_nome;
    profile.cpf = person.cpf;
    profile.email = profile.email || person.email;
    profile.foto_url = profile.foto_url || person.foto_url;
    profile.cargo_atual = person.cargo_atual;
    profile.empresa_atual = person.empresa_atual;
    profile.linkedin_url = person.linkedin_url;
    profile.localizacao = person.localizacao;
    profile.resumo_profissional = person.resumo_profissional;
    profile.sources_used.push('DB');

    // Connections from DB
    if (dbResult.connections?.length) {
      profile.empresas = dbResult.connections.map(c => ({
        cargo: c.cargo,
        qualificacao: c.qualificacao,
        data_entrada: c.data_entrada,
        ativo: c.ativo,
        empresa: c.dim_empresas
      }));
    }
  }

  // Apollo data (highest priority for professional)
  if (apolloResult) {
    const apollo = apolloResult;
    profile.nome_completo = profile.nome_completo || apollo.name || apollo.nome;
    profile.email = profile.email || apollo.email;
    profile.foto_url = profile.foto_url || apollo.photo_url || apollo.foto_url;
    // Professional: Apollo takes priority
    profile.cargo_atual = apollo.title || apollo.cargo || profile.cargo_atual;
    profile.empresa_atual = apollo.organization_name || apollo.empresa || profile.empresa_atual;
    profile.headline = apollo.headline || profile.headline;
    // LinkedIn: Apollo takes priority
    profile.linkedin_url = apollo.linkedin_url || profile.linkedin_url;
    profile.localizacao = profile.localizacao || apollo.city || apollo.localizacao;
    profile.sources_used.push('Apollo');
  }

  // Perplexity data (summaries and background)
  if (perplexityResult) {
    const perp = perplexityResult;
    profile.nome_completo = profile.nome_completo || perp.nome_completo || perp.nome;
    profile.resumo_profissional = perp.resumo_profissional || perp.resumo || profile.resumo_profissional;
    profile.cargo_atual = profile.cargo_atual || perp.cargo_atual || perp.cargo;
    profile.empresa_atual = profile.empresa_atual || perp.empresa_atual || perp.empresa;
    profile.localizacao = profile.localizacao || perp.localizacao;
    profile.sources_used.push('Perplexity');
  }

  // Serper data (LinkedIn URL fallback and general info)
  if (serperResult) {
    if (serperResult.linkedin && !profile.linkedin_url) {
      profile.linkedin_url = serperResult.linkedin;
      profile.sources_used.push('Google');
    } else if (serperResult.general) {
      if (!profile.sources_used.includes('Google')) {
        profile.sources_used.push('Google');
      }
    }
  }

  return profile;
}

/**
 * Execute query based on parsed intent
 * Uses Promise.allSettled for parallel source queries
 * @param {Object} parsedIntent - { intent, entities }
 * @returns {Object} - { data, count, queryType, sources_used, processingTime, error? }
 */
export async function executeQuery(parsedIntent) {
  const startTime = Date.now();
  const { intent, entities } = parsedIntent;

  // Determine query type mapping
  const queryTypeMap = {
    [INTENTS.SEARCH_PERSON]: 'search_person',
    [INTENTS.PERSON_DETAILS]: 'person_details',
    [INTENTS.PERSON_PROFESSIONAL]: 'person_professional',
    [INTENTS.PERSON_ACADEMIC]: 'person_academic',
    [INTENTS.PERSON_SOCIAL]: 'person_social',
    [INTENTS.PERSON_REPUTATION]: 'person_reputation',
    [INTENTS.PERSON_CONNECTIONS]: 'person_connections',
    [INTENTS.FOLLOW_UP]: 'person_details',
    [INTENTS.GENERAL]: 'general'
  };

  const queryType = queryTypeMap[intent] || 'general';

  // For GENERAL intent without entities, return help message
  if (intent === INTENTS.GENERAL && !entities.nome && !entities.cpf) {
    return {
      data: null,
      count: 0,
      queryType: 'general',
      sources_used: [],
      processingTime: Date.now() - startTime
    };
  }

  // Run guardrail check if we have enough data
  if (entities.nome || entities.cpf) {
    try {
      const guardrailResult = await runGuardrail({
        searchType: entities.cpf ? 'cpf' : 'nome',
        cpf: entities.cpf || undefined,
        nome: entities.nome || undefined,
        cidadeUf: entities.cidade || undefined
      });

      if (!guardrailResult.allowed) {
        logger.info('People Agent guardrail blocked query', {
          reason: guardrailResult.reason,
          entities
        });
        return {
          data: { blocked: true, reason: guardrailResult.reason, requiredFields: guardrailResult.requiredFields },
          count: 0,
          queryType,
          sources_used: ['guardrail'],
          processingTime: Date.now() - startTime
        };
      }
    } catch (error) {
      logger.warn('Guardrail check failed, proceeding anyway', { error: error.message });
    }
  }

  // Determine which sources to query
  const sources = SOURCE_MAP[intent] || ['db'];

  logger.info('People Agent executing parallel queries', {
    intent,
    sources,
    entities: { nome: entities.nome, cpf: entities.cpf ? '***' : null }
  });

  // Build parallel query promises
  const promises = {};

  if (sources.includes('db')) {
    promises.db = queryDatabase(entities);
  }
  if (sources.includes('apollo')) {
    promises.apollo = queryApollo(entities);
  }
  if (sources.includes('perplexity')) {
    promises.perplexity = queryPerplexity(entities);
  }
  if (sources.includes('serper')) {
    promises.serper = querySerper(entities);
  }

  // Execute all in parallel
  const keys = Object.keys(promises);
  const results = await Promise.allSettled(Object.values(promises));

  // Map results back to source names
  const settled = {};
  const sources_used = [];

  keys.forEach((key, index) => {
    const result = results[index];
    if (result.status === 'fulfilled' && result.value) {
      settled[key] = result.value;
      sources_used.push(key);
    } else if (result.status === 'rejected') {
      logger.warn(`People Agent source ${key} failed`, { error: result.reason?.message });
    }
  });

  const processingTime = Date.now() - startTime;

  // Handle CONNECTIONS intent specifically
  if (intent === INTENTS.PERSON_CONNECTIONS) {
    const dbData = settled.db;
    if (!dbData?.connections?.length) {
      return {
        data: null,
        count: 0,
        queryType,
        sources_used,
        processingTime
      };
    }

    return {
      data: {
        person: dbData.persons?.[0] || null,
        connections: dbData.connections
      },
      count: dbData.connections.length,
      queryType,
      sources_used,
      processingTime
    };
  }

  // Handle SEARCH_PERSON - return list of candidates
  if (intent === INTENTS.SEARCH_PERSON) {
    const dbData = settled.db;
    const candidates = dbData?.persons || [];

    return {
      data: candidates,
      count: candidates.length,
      queryType,
      sources_used,
      processingTime
    };
  }

  // For detail-oriented intents, merge into a profile
  const profile = mergePersonProfile(
    settled.db || null,
    settled.apollo || null,
    settled.perplexity || null,
    settled.serper || null
  );

  const hasData = profile.nome_completo || profile.email || profile.cargo_atual;

  return {
    data: hasData ? { profile } : null,
    count: hasData ? 1 : 0,
    queryType,
    sources_used: profile.sources_used,
    processingTime
  };
}

/**
 * Check if the query builder is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

export default {
  executeQuery,
  isConfigured
};
