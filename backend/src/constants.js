/**
 * Constants for scraping-hub
 * Avoid magic strings - use these constants
 */

// LinkedIn status
export const LINKEDIN_STATUS = {
  NAO_POSSUI: 'NAO_POSSUI',
  PENDENTE: 'PENDENTE'
};

// Tax regimes (Brazilian)
export const REGIME_TRIBUTARIO = {
  MEI: 'MEI',
  SIMPLES_NACIONAL: 'SIMPLES_NACIONAL',
  LUCRO_PRESUMIDO: 'LUCRO_PRESUMIDO',
  LUCRO_REAL: 'LUCRO_REAL',
  DESCONHECIDO: 'DESCONHECIDO'
};

// Revenue limits by regime (2024)
export const LIMITES_REGIME = {
  MEI: 81000,
  SIMPLES_ME: 360000,
  SIMPLES_EPP: 4800000,
  LUCRO_PRESUMIDO: 78000000
};

// Data sources for compliance registration
export const DATA_SOURCES = {
  SERPER: {
    nome: 'Serper - Google Search API',
    categoria: 'busca',
    fonte_primaria: 'Google',
    url: 'https://google.serper.dev',
    documentacao_url: 'https://serper.dev/docs',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'alta',
    observacoes: 'Busca Google para encontrar CNPJs'
  },
  PERPLEXITY: {
    nome: 'Perplexity AI',
    categoria: 'ia',
    fonte_primaria: 'Perplexity',
    url: 'https://api.perplexity.ai',
    documentacao_url: 'https://docs.perplexity.ai',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'media',
    observacoes: 'Fallback quando Serper não encontra empresa'
  },
  BRASILAPI: {
    nome: 'BrasilAPI - Receita Federal',
    categoria: 'governamental',
    fonte_primaria: 'Receita Federal do Brasil',
    url: 'https://brasilapi.com.br/api/cnpj/v1',
    documentacao_url: 'https://brasilapi.com.br/docs',
    formato: 'JSON',
    api_key_necessaria: false,
    confiabilidade: 'alta',
    cobertura_temporal: '1990-presente',
    observacoes: 'Dados oficiais de CNPJ da Receita Federal'
  },
  APOLLO: {
    nome: 'Apollo.io',
    categoria: 'enrichment',
    fonte_primaria: 'Apollo',
    url: 'https://api.apollo.io',
    documentacao_url: 'https://apolloio.github.io/apollo-api-docs',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'alta',
    observacoes: 'Enriquecimento de dados de empresas e pessoas (LinkedIn)'
  },
  CNPJA: {
    nome: 'CNPJá - Regime Tributário',
    categoria: 'fiscal',
    fonte_primaria: 'CNPJá',
    url: 'https://api.cnpja.com',
    documentacao_url: 'https://cnpja.com/docs',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'alta',
    cobertura_temporal: '2015-presente',
    observacoes: 'Histórico de Simples Nacional e MEI'
  },
  GITHUB: {
    nome: 'GitHub API',
    categoria: 'competencias',
    fonte_primaria: 'GitHub',
    url: 'https://api.github.com',
    documentacao_url: 'https://docs.github.com/en/rest',
    formato: 'JSON',
    api_key_necessaria: false,
    confiabilidade: 'alta',
    observacoes: 'Perfil técnico de desenvolvedores - repositórios, linguagens, contribuições'
  },
  GOOGLE_SCHOLAR: {
    nome: 'Google Scholar (via Serper)',
    categoria: 'competencias',
    fonte_primaria: 'Google Scholar',
    url: 'https://scholar.google.com',
    documentacao_url: 'https://serper.dev/docs',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'alta',
    observacoes: 'Publicações acadêmicas, citações, h-index'
  },
  GOOGLE_NEWS: {
    nome: 'Google News (via Serper)',
    categoria: 'reputacional',
    fonte_primaria: 'Google News',
    url: 'https://news.google.com',
    documentacao_url: 'https://serper.dev/docs',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'media',
    observacoes: 'Notícias e menções na mídia'
  },
  RECLAME_AQUI: {
    nome: 'Reclame Aqui (via Serper)',
    categoria: 'reputacional',
    fonte_primaria: 'Reclame Aqui',
    url: 'https://www.reclameaqui.com.br',
    documentacao_url: null,
    formato: 'HTML',
    api_key_necessaria: false,
    confiabilidade: 'media',
    observacoes: 'Reclamações de consumidores - busca por nome de pessoa/empresa'
  },
  BRASIL_DATA_HUB: {
    nome: 'Brasil Data Hub - Dados Geográficos',
    categoria: 'geografico',
    fonte_primaria: 'IBGE',
    url: 'https://mnfjkegtynjtgesfphge.supabase.co',
    documentacao_url: 'https://www.ibge.gov.br/geociencias/organizacao-do-territorio/estrutura-territorial/15761-areas-dos-municipios.html',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'alta',
    cobertura_temporal: '2010-presente',
    observacoes: 'Dados de municipios e estados brasileiros via Supabase (geo_municipios, geo_estados)'
  },
  IBGE_CNAE: {
    nome: 'IBGE - Classificação Nacional de Atividades Econômicas',
    categoria: 'economico',
    fonte_primaria: 'IBGE/Concla',
    url: 'https://servicodados.ibge.gov.br/api/v2/cnae',
    documentacao_url: 'https://cnae.ibge.gov.br',
    formato: 'JSON',
    api_key_necessaria: false,
    confiabilidade: 'alta',
    cobertura_temporal: '2006-presente',
    observacoes: 'Tabela completa de CNAEs (seções, divisões, grupos, classes, subclasses)'
  },
  BRASIL_DATA_HUB_EMENDAS: {
    nome: 'Brasil Data Hub - Emendas Parlamentares',
    categoria: 'politico',
    fonte_primaria: 'Portal da Transparência',
    url: 'https://mnfjkegtynjtgesfphge.supabase.co',
    documentacao_url: 'https://portaldatransparencia.gov.br/emendas',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'alta',
    cobertura_temporal: '2015-presente',
    observacoes: 'Emendas parlamentares individuais e de bancada via Supabase (fato_emendas_parlamentares)'
  }
};

// Module permissions
export const PERMISSIONS = {
  EMPRESAS: 'empresas',
  PESSOAS: 'pessoas',
  POLITICOS: 'politicos',
  NOTICIAS: 'noticias',
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// Search sources order (fallback chain)
export const SEARCH_FALLBACK_ORDER = ['serper', 'perplexity', 'serper_exact'];
