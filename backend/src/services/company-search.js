import { supabase } from '../database/supabase.js';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';
import { cacheGet, cacheSet, CACHE_TTL } from '../utils/cache.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const PREFETCH_MULTIPLIER = 4;
const PREFETCH_LIMIT = 100;
const SEARCH_CACHE_PREFIX = 'dim_empresas:search:v1';
const RECENT_CACHE_PREFIX = 'dim_empresas:recent:v1';
const SEARCH_RPC_FUNCTIONS = process.env.ENABLE_EMPRESAS_SEARCH_RPC === 'true'
  ? ['search_empresas_ranked_v1', 'search_empresas']
  : [];
const RECENT_RPC_FUNCTION = 'list_empresas_recent_v1';

function clampLimit(limit = DEFAULT_LIMIT) {
  return Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function normalizeState(state) {
  return state ? String(state).trim().toUpperCase() : null;
}

function cityMatches(companyCity, requestedCity) {
  const companyNorm = normalizeText(companyCity);
  const requestedNorm = normalizeText(requestedCity);
  return !!requestedNorm && companyNorm.includes(requestedNorm);
}

function baseSearchScore(candidate, queryNorm) {
  if (!candidate) return 0;
  if (candidate === queryNorm) return 1000;
  if (candidate.startsWith(queryNorm)) return 800;
  if (candidate.includes(queryNorm)) return 600;

  const queryWords = queryNorm.split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) return 0;

  const matchedWords = queryWords.filter(word => candidate.includes(word));
  return matchedWords.length > 0
    ? Math.round((matchedWords.length / queryWords.length) * 400)
    : 0;
}

function computeSearchScore(company, queryNorm) {
  const nomeFantasia = normalizeText(company.nome_fantasia);
  const razaoSocial = normalizeText(company.razao_social);
  const rpcScore = Number(company.search_score || 0);

  return Math.max(
    baseSearchScore(nomeFantasia, queryNorm),
    baseSearchScore(razaoSocial, queryNorm)
  ) + Math.round(rpcScore * 100);
}

function normalizeCompanyRow(row) {
  return {
    id: row.id,
    cnpj: row.cnpj || null,
    razao_social: row.razao_social || null,
    nome_fantasia: row.nome_fantasia || null,
    cidade: row.cidade || null,
    estado: row.estado || null,
    situacao_cadastral: row.situacao_cadastral || null,
    search_score: Number(row.search_score || row.similarity_score || 0),
  };
}

function stableSortCompanies(companies, query) {
  const queryNorm = normalizeText(query);

  return [...companies]
    .map(company => ({
      ...company,
      search_score: computeSearchScore(company, queryNorm),
    }))
    .sort((a, b) => {
      if (b.search_score !== a.search_score) return b.search_score - a.search_score;

      const aName = normalizeText(a.nome_fantasia || a.razao_social || '');
      const bName = normalizeText(b.nome_fantasia || b.razao_social || '');
      if (aName !== bName) return aName.localeCompare(bName);

      return String(a.id).localeCompare(String(b.id));
    });
}

async function tryRpcSearch({ query, cidade = null, estado = null, limit = DEFAULT_LIMIT }) {
  const safeLimit = clampLimit(limit);

  for (const fn of SEARCH_RPC_FUNCTIONS) {
    const { data, error } = await supabase.rpc(fn, {
      p_query: query,
      p_cidade: cidade,
      p_estado: normalizeState(estado),
      p_limit: safeLimit,
    });

    if (error) {
      if (error.code === '42883' || error.code === 'PGRST202') continue;
      logger.warn('company_search_rpc_failed', { fn, error: error.message, code: error.code });
      return null;
    }

    return stableSortCompanies((data || []).map(normalizeCompanyRow), query).slice(0, safeLimit);
  }

  return null;
}

async function fallbackSearch({ query, cidade = null, estado = null, limit = DEFAULT_LIMIT }) {
  const safeLimit = clampLimit(limit);
  const fetchLimit = cidade
    ? Math.min(safeLimit * PREFETCH_MULTIPLIER, PREFETCH_LIMIT)
    : safeLimit;
  const pattern = `%${escapeLike(query)}%`;

  let dbQuery = supabase
    .from('dim_empresas')
    .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral')
    .or(`nome_fantasia.ilike.${pattern},razao_social.ilike.${pattern}`)
    .limit(fetchLimit);

  const normalizedState = normalizeState(estado);
  if (normalizedState) {
    dbQuery = dbQuery.eq('estado', normalizedState);
  }

  const { data, error } = await dbQuery;
  if (error) {
    throw error;
  }

  let companies = (data || []).map(normalizeCompanyRow);
  if (cidade) {
    companies = companies.filter(company => cityMatches(company.cidade, cidade));
  }

  return stableSortCompanies(companies, query).slice(0, safeLimit);
}

export async function searchCompaniesByName({
  query,
  cidade = null,
  estado = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const trimmedQuery = String(query || '').trim();
  if (trimmedQuery.length < 2) return [];

  const safeLimit = clampLimit(limit);
  const cacheKey = [
    SEARCH_CACHE_PREFIX,
    normalizeText(trimmedQuery),
    normalizeText(cidade),
    normalizeState(estado) || '',
    safeLimit,
  ].join(':');

  const cached = await cacheGet(cacheKey);
  if (cached) {
    return cached;
  }

  let companies = await tryRpcSearch({
    query: trimmedQuery,
    cidade,
    estado,
    limit: safeLimit,
  });

  if (!companies || companies.length === 0) {
    companies = await fallbackSearch({
      query: trimmedQuery,
      cidade,
      estado,
      limit: safeLimit,
    });
  }

  await cacheSet(cacheKey, companies, CACHE_TTL.SEARCH);
  return companies;
}

async function tryRpcRecentList({ cursorId = null, limit = DEFAULT_LIMIT }) {
  const { data, error } = await supabase.rpc(RECENT_RPC_FUNCTION, {
    p_cursor_id: cursorId,
    p_limit: clampLimit(limit),
  });

  if (error) {
    if (error.code === '42883' || error.code === 'PGRST202') {
      return null;
    }

    logger.warn('company_recent_rpc_failed', {
      fn: RECENT_RPC_FUNCTION,
      error: error.message,
      code: error.code,
    });
    return null;
  }

  return (data || []).map(normalizeCompanyRow);
}

export async function listCompanyNodes({ limit = DEFAULT_LIMIT, cursorId = null } = {}) {
  const safeLimit = clampLimit(limit);
  const cacheKey = cursorId ? null : `${RECENT_CACHE_PREFIX}:${safeLimit}`;

  if (cacheKey) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return cached;
    }
  }

  let companies = await tryRpcRecentList({ cursorId, limit: safeLimit });
  if (!companies) {
    let dbQuery = supabase
      .from('dim_empresas')
      .select('id, cnpj, razao_social, nome_fantasia, cidade, estado, situacao_cadastral')
      .order('id', { ascending: false })
      .limit(safeLimit);

    if (cursorId) {
      dbQuery = dbQuery.lt('id', cursorId);
    }

    const { data, error } = await dbQuery;
    if (error) {
      throw error;
    }

    companies = (data || []).map(normalizeCompanyRow);
  }

  if (cacheKey) {
    await cacheSet(cacheKey, companies, CACHE_TTL.GRAPH);
  }

  return companies;
}

export async function getEstimatedCompanyCount() {
  const cacheKey = 'dim_empresas:estimated_count:v1';
  const cached = await cacheGet(cacheKey);
  if (cached != null) {
    return cached;
  }

  const { count, error } = await supabase
    .from('dim_empresas')
    .select('id', { count: 'estimated', head: true });

  if (error) {
    throw error;
  }

  const value = count || 0;
  await cacheSet(cacheKey, value, CACHE_TTL.SEARCH);
  return value;
}
