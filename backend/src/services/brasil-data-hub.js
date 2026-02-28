/**
 * MCP Brasil Data Hub - Geographic Data Service
 *
 * Conecta ao Supabase brasil-data-hub para buscar dados geograficos:
 * - geo_municipios: Municipios brasileiros (codigo_ibge, nome, uf, eh_capital, etc)
 * - geo_estados: Estados brasileiros (codigo_ibge_uf, nome, sigla, regiao)
 *
 * @version 1.0.0
 * @source brasil-data-hub (Supabase: mnfjkegtynjtgesfphge)
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../utils/logger.js';
import { escapeLike } from '../utils/sanitize.js';

// Configuracao do cliente brasil-data-hub
const brasilDataHubUrl = process.env.BRASIL_DATA_HUB_URL;
const brasilDataHubKey = process.env.BRASIL_DATA_HUB_KEY;

let supabaseClient = null;

/**
 * Inicializa o cliente Supabase para brasil-data-hub
 */
function getClient() {
  if (!supabaseClient) {
    if (!brasilDataHubUrl || !brasilDataHubKey) {
      logger.warn('Brasil Data Hub credentials not configured');
      return null;
    }
    supabaseClient = createClient(brasilDataHubUrl, brasilDataHubKey, {
      db: { schema: 'raw' }
    });
  }
  return supabaseClient;
}

/**
 * Busca municipio por codigo IBGE
 * @param {string} codigoIbge - Codigo IBGE do municipio (7 digitos)
 * @returns {Promise<Object|null>} Dados do municipio ou null
 */
export async function getMunicipioByCodigo(codigoIbge) {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('geo_municipios')
      .select('*')
      .eq('codigo_ibge', codigoIbge)
      .single();

    if (error) {
      logger.error('Erro ao buscar municipio', { codigoIbge, error: error.message });
      return null;
    }

    return data;
  } catch (err) {
    logger.error('Erro ao buscar municipio', { codigoIbge, error: err.message });
    return null;
  }
}

/**
 * Busca municipio por nome e UF
 * @param {string} nome - Nome do municipio
 * @param {string} uf - Sigla do estado (2 letras)
 * @returns {Promise<Object|null>} Dados do municipio ou null
 */
export async function getMunicipioByNome(nome, uf) {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('geo_municipios')
      .select('*')
      .ilike('nome', escapeLike(nome))
      .eq('uf', uf.toUpperCase())
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Erro ao buscar municipio por nome', { nome, uf, error: error.message });
      return null;
    }

    return data;
  } catch (err) {
    logger.error('Erro ao buscar municipio por nome', { nome, uf, error: err.message });
    return null;
  }
}

/**
 * Busca todas as capitais brasileiras
 * @param {string} [regiao] - Filtrar por regiao (Norte, Nordeste, Centro-Oeste, Sudeste, Sul)
 * @returns {Promise<Array>} Lista de capitais
 */
export async function getCapitais(regiao = null) {
  const client = getClient();
  if (!client) return [];

  try {
    let query = client
      .from('geo_municipios')
      .select('*')
      .eq('eh_capital', true)
      .order('nome');

    if (regiao) {
      query = query.eq('regiao', regiao);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Erro ao buscar capitais', { regiao, error: error.message });
      return [];
    }

    return data || [];
  } catch (err) {
    logger.error('Erro ao buscar capitais', { regiao, error: err.message });
    return [];
  }
}

/**
 * Busca municipios por UF
 * @param {string} uf - Sigla do estado (2 letras)
 * @returns {Promise<Array>} Lista de municipios
 */
export async function getMunicipiosByUf(uf) {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('geo_municipios')
      .select('*')
      .eq('uf', uf.toUpperCase())
      .order('nome');

    if (error) {
      logger.error('Erro ao buscar municipios por UF', { uf, error: error.message });
      return [];
    }

    return data || [];
  } catch (err) {
    logger.error('Erro ao buscar municipios por UF', { uf, error: err.message });
    return [];
  }
}

/**
 * Busca estado por codigo IBGE UF
 * @param {string} codigoIbgeUf - Codigo IBGE do estado (2 digitos)
 * @returns {Promise<Object|null>} Dados do estado ou null
 */
export async function getEstadoByCodigo(codigoIbgeUf) {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('geo_estados')
      .select('*')
      .eq('codigo_ibge_uf', codigoIbgeUf)
      .single();

    if (error) {
      logger.error('Erro ao buscar estado', { codigoIbgeUf, error: error.message });
      return null;
    }

    return data;
  } catch (err) {
    logger.error('Erro ao buscar estado', { codigoIbgeUf, error: err.message });
    return null;
  }
}

/**
 * Busca estado por sigla (UF)
 * @param {string} sigla - Sigla do estado (2 letras)
 * @returns {Promise<Object|null>} Dados do estado ou null
 */
export async function getEstadoBySigla(sigla) {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('geo_estados')
      .select('*')
      .eq('sigla', sigla.toUpperCase())
      .single();

    if (error) {
      logger.error('Erro ao buscar estado por sigla', { sigla, error: error.message });
      return null;
    }

    return data;
  } catch (err) {
    logger.error('Erro ao buscar estado por sigla', { sigla, error: err.message });
    return null;
  }
}

/**
 * Busca todos os estados
 * @param {string} [regiao] - Filtrar por regiao
 * @returns {Promise<Array>} Lista de estados
 */
export async function getEstados(regiao = null) {
  const client = getClient();
  if (!client) return [];

  try {
    let query = client
      .from('geo_estados')
      .select('*')
      .order('nome');

    if (regiao) {
      query = query.eq('regiao', regiao);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('Erro ao buscar estados', { regiao, error: error.message });
      return [];
    }

    return data || [];
  } catch (err) {
    logger.error('Erro ao buscar estados', { regiao, error: err.message });
    return [];
  }
}

/**
 * Enriquece dados de empresa com informacoes geograficas
 * @param {Object} empresa - Objeto empresa com codigo_ibge
 * @returns {Promise<Object>} Empresa enriquecida com dados geograficos
 */
export async function enrichEmpresaWithGeo(empresa) {
  if (!empresa?.codigo_ibge) {
    return empresa;
  }

  const municipio = await getMunicipioByCodigo(empresa.codigo_ibge);

  if (municipio) {
    return {
      ...empresa,
      municipio_nome: municipio.nome,
      uf: municipio.uf,
      regiao: municipio.regiao,
      eh_capital: municipio.eh_capital,
      populacao: municipio.populacao,
      area_km2: municipio.area_km2
    };
  }

  return empresa;
}

/**
 * Resolve codigo IBGE a partir de cidade e estado
 * Usado para migrar dados antigos que tinham cidade/estado separados
 * @param {string} cidade - Nome da cidade
 * @param {string} estado - UF do estado
 * @returns {Promise<string|null>} Codigo IBGE ou null
 */
export async function resolveCodigoIbge(cidade, estado) {
  if (!cidade || !estado) return null;

  const municipio = await getMunicipioByNome(cidade, estado);
  return municipio?.codigo_ibge || null;
}

// Export default object for compatibility
export default {
  getMunicipioByCodigo,
  getMunicipioByNome,
  getCapitais,
  getMunicipiosByUf,
  getEstadoByCodigo,
  getEstadoBySigla,
  getEstados,
  enrichEmpresaWithGeo,
  resolveCodigoIbge
};
