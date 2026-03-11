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
  GEMINI: {
    nome: 'Google Gemini AI',
    categoria: 'ia',
    fonte_primaria: 'Google',
    url: 'https://generativelanguage.googleapis.com',
    documentacao_url: 'https://ai.google.dev/docs',
    formato: 'JSON',
    api_key_necessaria: true,
    confiabilidade: 'media',
    observacoes: 'Busca de website de empresa via IA generativa (fallback)'
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
  MANDATOS: 'mandatos',
  EMENDAS: 'emendas',
  NOTICIAS: 'noticias',
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// User roles
export const ROLES = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  USER: 'user',
};

export const ALL_ROLES = Object.values(ROLES);

// Search sources order (fallback chain)
export const SEARCH_FALLBACK_ORDER = ['serper', 'perplexity', 'serper_exact'];

// Graph relationship types
export const RELATIONSHIP_TYPES = {
  SOCIETARIA: 'societaria',
  FORNECEDOR: 'fornecedor',
  CONCORRENTE: 'concorrente',
  PARCEIRO: 'parceiro',
  REGULADOR: 'regulador',
  BENEFICIARIO: 'beneficiario',
  MENCIONADO_EM: 'mencionado_em',
  CNAE_SIMILAR: 'cnae_similar',
  GEOGRAFICO: 'geografico',
  POLITICO_EMPRESARIAL: 'politico_empresarial',
  CLIENTE_DE: 'cliente_de',
  FORNECEDOR_DE: 'fornecedor_de',
  CONCORRENTE_DE: 'concorrente_de',
  PARCEIRO_DE: 'parceiro_de',
  OPORTUNIDADE: 'oportunidade',
};

export const ALL_RELATIONSHIP_TYPES = Object.values(RELATIONSHIP_TYPES);

// Entity types for graph nodes
export const ENTITY_TYPES = {
  EMPRESA: 'empresa',
  PESSOA: 'pessoa',
  POLITICO: 'politico',
  EMENDA: 'emenda',
  NOTICIA: 'noticia',
  MANDATO: 'mandato',
};

// Ecosystem relationship types
export const ECOSYSTEM_TYPES = {
  CLIENTE: 'cliente',
  FORNECEDOR: 'fornecedor',
  CONCORRENTE: 'concorrente',
  PARCEIRO: 'parceiro',
};

// Evidence types
export const EVIDENCE_TYPES = {
  MENCAO_WEBSITE: 'mencao_website',
  RELACAO_SOCIETARIA: 'relacao_societaria',
  CONTRATO_PUBLICO: 'contrato_publico',
  MENCAO_NOTICIA: 'mencao_noticia',
  CORRELACAO_CNAE: 'correlacao_cnae',
  PROXIMIDADE_GEO: 'proximidade_geo',
  INFERENCIA_GEMINI: 'inferencia_gemini',
  DADO_CADASTRAL: 'dado_cadastral',
};

// Evidence sources
export const EVIDENCE_SOURCES = {
  GEMINI_CRAWL: 'gemini_crawl',
  CNAE_CORRELACAO: 'cnae_correlacao',
  GEO_ANALISE: 'geo_analise',
  NOTICIA: 'noticia',
  SOCIETARIO: 'societario',
  BRASILAPI: 'brasilapi',
  APOLLO: 'apollo',
};

// Opportunity types
export const OPPORTUNITY_TYPES = {
  VENDA_DIRETA: 'venda_direta',
  PARCERIA: 'parceria',
  FORNECIMENTO: 'fornecimento',
  EXPANSAO_GEOGRAFICA: 'expansao_geografica',
};

// Lead temperature
export const LEAD_TEMPERATURA = {
  QUENTE: 'quente',
  MORNO: 'morno',
  FRIO: 'frio',
};

// Opportunity priority
export const OPORTUNIDADE_PRIORIDADE = {
  CRITICA: 'critica',
  ALTA: 'alta',
  MEDIA: 'media',
  BAIXA: 'baixa',
};

// Opportunity scoring weights
export const OPPORTUNITY_WEIGHTS = {
  GEOGRAFICO: 0.20,
  CNAE: 0.25,
  TRIBUTARIO: 0.15,
  TEMPORAL: 0.10,
  EVIDENCIA: 0.30,
};

// Company porte classification
export const PORTE_EMPRESA = {
  MEI: 'MEI',
  ME: 'ME',
  EPP: 'EPP',
  MEDIO: 'MEDIO',
  GRANDE: 'GRANDE',
};

// Buyer persona
export const PERFIL_COMPRADOR = {
  PRICE_SENSITIVE: 'price_sensitive',
  VALUE_ORIENTED: 'value_oriented',
  PREMIUM: 'premium',
};

// Geographic arc of operation
export const ARCO_ATUACAO = {
  LOCAL: 'local',
  MUNICIPAL: 'municipal',
  ESTADUAL: 'estadual',
  REGIONAL: 'regional',
  NACIONAL: 'nacional',
  INTERNACIONAL: 'internacional',
};

export const ALL_ENTITY_TYPES = Object.values(ENTITY_TYPES);

// Average revenue per employee by sector (annual, BRL)
export const FATURAMENTO_POR_FUNCIONARIO = {
  comercio: 180000,
  servicos: 120000,
  industria: 250000,
  tecnologia: 200000,
  default: 150000
};

// VAR model weights (empirically calibrated)
export const PESOS_VAR = {
  qtd_funcionarios: 0.30,
  capital_social: 0.15,
  anos_operando: 0.20,
  qtd_mudancas_regime: 0.15,
  qtd_socios: 0.10,
  qtd_cnaes: 0.10
};

// Capital social thresholds for revenue adjustment
export const CAPITAL_SOCIAL_THRESHOLDS = {
  MODERATE: { value: 100000, multiplier: 1.2 },
  HIGH: { value: 500000, multiplier: 1.5 }
};

// Growth adjustment per year (after 5 years operating)
export const GROWTH_RATE_PER_YEAR = 0.02;
export const GROWTH_MIN_YEARS = 5;

// Regime change probability score thresholds
export const VAR_SCORE_THRESHOLDS = {
  PROXIMITY_HIGH: { threshold: 0.9, score: 40 },
  PROXIMITY_MEDIUM: { threshold: 0.7, score: 25 },
  PROXIMITY_LOW: { threshold: 0.5, score: 10 },
  MEI_EXCEEDED_EMPLOYEES: 50,
  REGIME_CHANGES_MANY: { count: 2, score: 15 },
  REGIME_CHANGES_ONE: { count: 1, score: 10 },
  MEI_LONG_TENURE: { years: 10, score: 20 }
};

// Estimated months to regime change based on score
export const MONTHS_TO_CHANGE = {
  HIGH: { minScore: 50, months: 12 },
  MEDIUM: { minScore: 30, months: 24 }
};

// CNAE sector mapping (first 2 digits → sector)
export const CNAE_SECTOR_MAP = {
  '01': 'industria', '02': 'industria', '03': 'industria',
  '10': 'industria', '11': 'industria', '12': 'industria',
  '45': 'comercio', '46': 'comercio', '47': 'comercio',
  '62': 'tecnologia', '63': 'tecnologia',
  '69': 'servicos', '70': 'servicos', '71': 'servicos'
};

// Regime progression order
export const REGIME_PROGRESSION = {
  'MEI': 'SIMPLES_NACIONAL',
  'SIMPLES_NACIONAL': 'LUCRO_PRESUMIDO',
  'LUCRO_PRESUMIDO': 'LUCRO_REAL',
  'LUCRO_REAL': 'LUCRO_REAL'
};

// Portuguese stop words for search queries
export const SEARCH_STOP_WORDS = new Set([
  'e', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na',
  'nos', 'nas', 'a', 'o', 'os', 'as', 'um', 'uma', 'para', 'com', 'por'
]);

// Timezone for stats snapshots
export const STATS_TIMEZONE = 'America/Sao_Paulo';
export const STATS_UTC_OFFSET = 'T03:00:00.000Z';

// Data source labels (used in inserts)
export const FONTE = {
  BRASILAPI_SERPER_APOLLO: 'brasilapi+serper+apollo',
  PERPLEXITY: 'perplexity',
  BATCH_INSERT: 'batch_insert',
  BRASILAPI: 'brasilapi',
  MANUAL: 'manual'
};
