const API_BASE = '/api';

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
}

// ============================================
// AUTH API
// ============================================

export async function login(data: LoginRequest): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Login failed' }));
    throw new Error(error.detail || 'Login failed');
  }

  return res.json();
}

export async function getUser(): Promise<{ email: string; name: string; role: string }> {
  const token = localStorage.getItem('token');
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error('Not authenticated');
  }

  return res.json();
}

export async function getHealth(): Promise<{ version: string; status: string }> {
  const res = await fetch('/health');
  if (!res.ok) {
    return { version: '1.0.0', status: 'unknown' };
  }
  return res.json();
}

// ============================================
// STATS API
// ============================================

export interface StatItem {
  categoria: string;
  total: number;
  total_ontem: number;
  crescimento_percentual: number;
}

export interface StatsCurrentResponse {
  success: boolean;
  stats: StatItem[];
  data_referencia: string;
  online: boolean;
  proxima_atualizacao_segundos: number;
  timestamp: string;
}

export interface HistoryPoint {
  data: string;
  total: number;
}

export interface StatsHistoryResponse {
  success: boolean;
  historico: Record<string, HistoryPoint[]>;
  categorias: string[];
  total_registros: number;
  timestamp: string;
}

// Legacy interface for backwards compatibility
export interface StatsResponse {
  success: boolean;
  stats: {
    empresas: number;
    pessoas: number;
    politicos: number;
    mandatos: number;
    noticias: number;
  };
}

export async function getStatsCurrent(): Promise<StatsCurrentResponse> {
  const res = await fetch(`${API_BASE}/stats/current`);
  if (!res.ok) {
    return {
      success: false,
      stats: [],
      data_referencia: new Date().toISOString(),
      online: false,
      proxima_atualizacao_segundos: 300,
      timestamp: new Date().toISOString(),
    };
  }
  return res.json();
}

export async function getStatsHistory(limit = 30): Promise<StatsHistoryResponse> {
  const res = await fetch(`${API_BASE}/stats/history?limit=${limit}`);
  if (!res.ok) {
    return {
      success: false,
      historico: {},
      categorias: [],
      total_registros: 0,
      timestamp: new Date().toISOString(),
    };
  }
  return res.json();
}

export async function createStatsSnapshot(): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`${API_BASE}/stats/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    return { success: false };
  }
  return res.json();
}

// Legacy function - converts new format to old format
export async function getStats(): Promise<StatsResponse> {
  const res = await fetch(`${API_BASE}/stats/current`);
  if (!res.ok) {
    return {
      success: false,
      stats: { empresas: 0, pessoas: 0, politicos: 0, mandatos: 0, noticias: 0 },
    };
  }

  const data: StatsCurrentResponse = await res.json();
  const statsObj: Record<string, number> = {};

  for (const stat of data.stats) {
    statsObj[stat.categoria] = stat.total;
  }

  return {
    success: data.success,
    stats: {
      empresas: statsObj.empresas || 0,
      pessoas: statsObj.pessoas || 0,
      politicos: statsObj.politicos || 0,
      mandatos: statsObj.mandatos || 0,
      noticias: statsObj.noticias || 0,
    },
  };
}

// ============================================
// ATLAS CHAT API
// ============================================

export interface AtlasChatRequest {
  message: string;
  sessionId?: string;
}

interface AtlasBackendResponse {
  success: boolean;
  sessionId: string;
  response: {
    text: string;
    data?: unknown[];
    suggestions?: string[];
  };
  error?: string;
}

export interface AtlasChatResponse {
  text: string;
  sessionId: string;
  data?: unknown[];
  suggestions?: string[];
}

export async function atlasChat(data: AtlasChatRequest): Promise<AtlasChatResponse> {
  const token = localStorage.getItem('token');

  const res = await fetch(`${API_BASE}/atlas/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Chat failed' }));
    throw new Error(error.detail || 'Chat failed');
  }

  const result: AtlasBackendResponse = await res.json();

  if (!result.success) {
    throw new Error(result.error || 'Chat failed');
  }

  return {
    text: result.response.text,
    sessionId: result.sessionId,
    data: result.response.data,
    suggestions: result.response.suggestions,
  };
}

// ============================================
// COMPANIES API
// ============================================

export interface CompanySearchRequest {
  nome?: string;
  cidade?: string;
  segmento?: string;
  regime?: string;
}

export interface CompanyCandidate {
  cnpj: string;
  cnpj_formatted: string;
  razao_social: string;
  nome_fantasia?: string;
  localizacao?: string;
  fonte?: 'interno' | 'externo';
}

export interface CompanySearchResponse {
  found: boolean;
  single_match: boolean;
  company?: CompanyCandidate;
  candidates?: CompanyCandidate[];
  requestId?: string;
  source?: string;
  durationMs?: number;
  searchSource?: string;
  limits?: {
    serperMaxResults: number;
    enrichmentLimit: number;
    note: string;
  };
}

export async function searchCompany(data: CompanySearchRequest): Promise<CompanySearchResponse> {
  const res = await fetch(`${API_BASE}/companies/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Search failed' }));
    throw new Error(error.error || 'Search failed');
  }

  return res.json();
}

export interface CompanyDetails {
  cnpj: string;
  razao_social: string;
  nome_fantasia?: string;
  cnae_principal?: string;
  cnae_descricao?: string;
  porte?: string;
  situacao_cadastral?: string;
  capital_social?: number;
  logradouro?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  telefone_1?: string;
  email?: string;
  website?: string;
  linkedin?: string;
}

export interface Socio {
  nome: string;
  cpf?: string;
  qualificacao?: string;
  cargo?: string;
  email?: string;
  linkedin?: string;
  foto_url?: string;
  headline?: string;
  ativo?: boolean;
  novo?: boolean;
  data_entrada?: string;
  faixa_etaria?: string;
  pais_origem?: string;
}

export interface CompanyDetailsResponse {
  exists: boolean;
  empresa: CompanyDetails;
  socios: Socio[];
  socios_ativos?: Socio[];
  socios_inativos?: Socio[];
  socios_novos?: Socio[];
}

export async function getCompanyDetails(cnpj: string): Promise<CompanyDetailsResponse> {
  const res = await fetch(`${API_BASE}/companies/details`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cnpj }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Details failed' }));
    throw new Error(error.error || 'Details failed');
  }

  return res.json();
}

export interface EnrichSociosRequest {
  socios: Socio[];
  empresa_nome: string;
}

export interface EnrichSociosResponse {
  success: boolean;
  socios: Socio[];
  error?: string;
}

export async function enrichSocios(data: EnrichSociosRequest): Promise<EnrichSociosResponse> {
  const res = await fetch(`${API_BASE}/companies/socios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Enrich failed' }));
    throw new Error(error.error || 'Enrich failed');
  }

  return res.json();
}

export interface ApproveCompanyRequest {
  empresa: CompanyDetails;
  socios: Socio[];
  aprovado_por: string;
}

export interface ApproveCompanyResponse {
  success: boolean;
  socios?: { length: number };
  error?: string;
}

export async function approveCompany(data: ApproveCompanyRequest): Promise<ApproveCompanyResponse> {
  const res = await fetch(`${API_BASE}/companies/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Approve failed' }));
    throw new Error(error.error || error.details || 'Approve failed');
  }

  return res.json();
}

export interface Company {
  id: string;
  cnpj: string;
  razao_social: string;
  nome_fantasia?: string;
  cidade?: string;
  estado?: string;
  cnae_descricao?: string;
  regime_tributario?: string;
  linkedin?: string;
  situacao_cadastral?: string;
}

export interface CompanyListResponse {
  success: boolean;
  empresas: Company[];
  count: number;
  total: number;
  offset: number;
  limit: number;
  requestId?: string;
  source?: string;
  durationMs?: number;
  error?: string;
}

export async function listCompanies(params?: {
  nome?: string;
  cidade?: string;
  segmento?: string;
  regime?: string;
  limit?: number;
  offset?: number;
}): Promise<CompanyListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.nome) searchParams.append('nome', params.nome);
  if (params?.cidade) searchParams.append('cidade', params.cidade);
  if (params?.segmento) searchParams.append('segmento', params.segmento);
  if (params?.regime) searchParams.append('regime', params.regime);
  searchParams.append('limit', String(params?.limit || 100));
  searchParams.append('offset', String(params?.offset || 0));

  const res = await fetch(`${API_BASE}/companies/list?${searchParams.toString()}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'List failed' }));
    throw new Error(error.error || 'List failed');
  }

  return res.json();
}

export interface CheckExistingResponse {
  success: boolean;
  existing: string[];
  checked: number;
}

export async function checkExistingCnpjs(cnpjs: string[]): Promise<CheckExistingResponse> {
  const res = await fetch(`${API_BASE}/companies/check-existing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cnpjs }),
  });

  if (!res.ok) {
    return { success: false, existing: [], checked: 0 };
  }

  return res.json();
}

// ============================================
// CNAE API
// ============================================

export interface Cnae {
  codigo: string;
  subclasse?: string;
  descricao: string;
  descricao_secao?: string;
  descricao_divisao?: string;
  descricao_grupo?: string;
  descricao_classe?: string;
}

export interface CnaeListResponse {
  data: Cnae[];
}

export async function listCnaes(limit = 2000): Promise<CnaeListResponse> {
  const res = await fetch(`${API_BASE}/companies/cnae?limit=${limit}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'CNAE list failed' }));
    throw new Error(error.detail || 'CNAE list failed');
  }

  return res.json();
}

// ============================================
// PEOPLE API
// ============================================

export interface Person {
  id: string;
  nome?: string;
  nome_completo?: string;
  email?: string;
  pais?: string;
  faixa_etaria?: string;
  linkedin_url?: string;
}

export interface PersonListResponse {
  success: boolean;
  people: Person[];
  count: number;
  error?: string;
}

export async function listPeople(params?: {
  nome?: string;
  cidade?: string;
  limit?: number;
}): Promise<PersonListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.nome) searchParams.append('nome', params.nome);
  if (params?.cidade) searchParams.append('cidade', params.cidade);
  searchParams.append('limit', String(params?.limit || 50));

  const res = await fetch(`${API_BASE}/people/list?${searchParams.toString()}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'List failed' }));
    throw new Error(error.error || 'List failed');
  }

  return res.json();
}

export async function searchPeople(nome: string): Promise<PersonListResponse> {
  const res = await fetch(`${API_BASE}/people/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Search failed' }));
    throw new Error(error.error || 'Search failed');
  }

  return res.json();
}

export interface Experience {
  titulo?: string;
  instituicao?: string;
  data_inicio?: string;
  data_fim?: string;
}

export interface RelatedCompany {
  cargo?: string;
  dim_empresas?: {
    razao_social?: string;
    nome_fantasia?: string;
    cidade?: string;
    estado?: string;
  };
}

export interface PersonDetailsResponse {
  success: boolean;
  pessoa: Person;
  experiencias?: Experience[];
  empresas?: RelatedCompany[];
  error?: string;
}

export async function getPersonDetails(personId: string): Promise<PersonDetailsResponse> {
  const res = await fetch(`${API_BASE}/people/${personId}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Details failed' }));
    throw new Error(error.error || 'Details failed');
  }

  return res.json();
}

export interface CpfSearchRequest {
  cpf?: string;
  nome?: string;
}

export interface CpfSearchPessoa {
  id?: string;
  cpf: string;
  nome_completo?: string;
  cargo_atual?: string;
  empresa_atual?: string;
  linkedin_url?: string;
  email?: string;
  localizacao?: string;
  resumo_profissional?: string;
  foto_url?: string;
}

export interface CpfSearchExperiencia {
  cargo: string;
  empresa: string;
  periodo: string;
}

export interface CpfSearchResponse {
  success: boolean;
  source: 'database' | 'perplexity' | 'serper' | 'none';
  found: boolean;
  pessoa: CpfSearchPessoa | null;
  experiencias?: CpfSearchExperiencia[];
  fontes?: string[];
  apollo_enriched?: boolean;
  message?: string;
  error?: string;
  preliminary?: boolean;
  db_matches?: CpfSearchPessoa[];
  needs_surname?: boolean;
}

export async function searchPersonByCpf(data: CpfSearchRequest): Promise<CpfSearchResponse> {
  const res = await fetch(`${API_BASE}/people/search-cpf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'CPF search failed' }));
    throw new Error(error.error || 'CPF search failed');
  }

  return res.json();
}

export interface CreditBureau {
  nome: string;
  status: string;
  tipo: string;
  api: string;
  documentacao: string;
  requisitos: string[];
  servicos: string[];
}

export interface CreditBureausResponse {
  success: boolean;
  available: boolean;
  message: string;
  bureaus: CreditBureau[];
  nota: string;
}

export async function getCreditBureaus(): Promise<CreditBureausResponse> {
  const res = await fetch(`${API_BASE}/people/credit-bureaus`);

  if (!res.ok) {
    throw new Error('Failed to get credit bureaus info');
  }

  return res.json();
}

export interface SavePersonRequest {
  pessoa: CpfSearchPessoa;
  experiencias?: CpfSearchExperiencia[];
  aprovado_por: string;
}

export interface SavePersonResponse {
  success: boolean;
  pessoa?: {
    id: string;
    nome_completo: string;
  };
  message?: string;
  error?: string;
}

export async function savePerson(data: SavePersonRequest): Promise<SavePersonResponse> {
  const res = await fetch(`${API_BASE}/people/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Save failed' }));
    throw new Error(error.error || 'Save failed');
  }

  return res.json();
}

// ============================================
// PEOPLE V2 API (Guardrail + Pagination + Batch)
// ============================================

export interface GuardrailResult {
  allowed: boolean;
  reason: string;
  requiredFields: string[];
  normalizedQuery: string;
  durationMs: number;
}

export interface PeopleSearchV2Request {
  searchType: 'cpf' | 'nome';
  cpf?: string;
  nome?: string;
  dataNascimento?: string;
  cidadeUf?: string;
  page?: number;
  pageSize?: number;
}

export interface PeopleSearchResult {
  id?: string;
  cpf?: string;
  nome_completo?: string;
  primeiro_nome?: string;
  sobrenome?: string;
  cargo_atual?: string;
  empresa_atual?: string;
  linkedin_url?: string;
  email?: string;
  localizacao?: string;
  resumo_profissional?: string;
  foto_url?: string;
  _source?: 'db' | 'external';
  _provider?: string;
}

export interface PeopleSearchV2Response {
  success: boolean;
  guardrail: GuardrailResult;
  results: PeopleSearchResult[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  badges: {
    total: number;
    db: number;
    new: number;
  };
  sources_tried: string[];
  requestId: string;
  durationMs: number;
  error?: string;
}

export async function searchPeopleV2(
  data: PeopleSearchV2Request,
  signal?: AbortSignal
): Promise<PeopleSearchV2Response> {
  const res = await fetch(`${API_BASE}/people/search-v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Search V2 failed' }));
    throw new Error(error.error || 'Search V2 failed');
  }

  return res.json();
}

export interface PeopleCheckExistingResponse {
  success: boolean;
  existing: string[];
  checked: number;
}

export async function checkExistingPeople(params: {
  ids?: string[];
  cpfs?: string[];
}): Promise<PeopleCheckExistingResponse> {
  const res = await fetch(`${API_BASE}/people/check-existing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    return { success: false, existing: [], checked: 0 };
  }

  return res.json();
}

export interface PeopleSaveBatchRequest {
  pessoas: CpfSearchPessoa[];
  aprovado_por: string;
}

export interface PeopleSaveBatchResponse {
  success: boolean;
  inserted: number;
  existed: number;
  failed: number;
  results: Array<{
    nome: string;
    status: 'inserted' | 'existed' | 'failed';
    id?: string;
    error?: string;
  }>;
  durationMs: number;
}

export async function savePeopleBatch(data: PeopleSaveBatchRequest): Promise<PeopleSaveBatchResponse> {
  const res = await fetch(`${API_BASE}/people/save-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Batch save failed' }));
    throw new Error(error.error || 'Batch save failed');
  }

  return res.json();
}

// ============================================
// NEWS API
// ============================================

export interface NewsSource {
  id: string;
  nome: string;
  url?: string;
}

export interface NewsSourcesResponse {
  success: boolean;
  sources: NewsSource[];
}

export async function listNewsSources(): Promise<NewsSourcesResponse> {
  const res = await fetch(`${API_BASE}/news/sources/list`);

  if (!res.ok) {
    return { success: false, sources: [] };
  }

  return res.json();
}

export interface NewsItem {
  id: string;
  titulo: string;
  resumo?: string;
  conteudo?: string;
  fonte?: string;
  fonte_nome?: string;
  data_publicacao?: string;
  url?: string;
  tipo?: string;
  relevancia?: string;
  data?: string;
}

export interface NewsListResponse {
  success: boolean;
  news: NewsItem[];
  count: number;
  error?: string;
}

export async function listNews(params?: {
  q?: string;
  data_inicio?: string;
  data_fim?: string;
  idioma?: string;
  pais?: string;
  fonte?: string;
  tipo?: string;
  limit?: number;
}): Promise<NewsListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.q) searchParams.append('q', params.q);
  if (params?.data_inicio) searchParams.append('data_inicio', params.data_inicio);
  if (params?.data_fim) searchParams.append('data_fim', params.data_fim);
  if (params?.idioma) searchParams.append('idioma', params.idioma);
  if (params?.pais) searchParams.append('pais', params.pais);
  if (params?.fonte) searchParams.append('fonte', params.fonte);
  if (params?.tipo) searchParams.append('tipo', params.tipo);
  searchParams.append('limit', String(params?.limit || 50));

  const res = await fetch(`${API_BASE}/news/list?${searchParams.toString()}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'List failed' }));
    throw new Error(error.error || 'List failed');
  }

  return res.json();
}

export interface NewsSearchAIResponse {
  success: boolean;
  news: NewsItem[];
  count: number;
  transformed_query?: string;
  query_context?: string;
  citations?: string[];
  error?: string;
}

export async function searchNewsAI(params: {
  q: string;
  idioma?: string;
  pais?: string;
  fonte?: string;
  data_inicio?: string;
  data_fim?: string;
}): Promise<NewsSearchAIResponse> {
  const searchParams = new URLSearchParams();
  searchParams.append('q', params.q);
  if (params.idioma) searchParams.append('idioma', params.idioma);
  if (params.pais) searchParams.append('pais', params.pais);
  if (params.fonte) searchParams.append('fonte', params.fonte);
  if (params.data_inicio) searchParams.append('data_inicio', params.data_inicio);
  if (params.data_fim) searchParams.append('data_fim', params.data_fim);

  const res = await fetch(`${API_BASE}/news/search-ai?${searchParams.toString()}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Search failed' }));
    throw new Error(error.error || 'Search failed');
  }

  return res.json();
}

export interface NewsDetailsResponse {
  success: boolean;
  news: NewsItem;
  error?: string;
}

export async function getNewsDetails(newsId: string): Promise<NewsDetailsResponse> {
  const res = await fetch(`${API_BASE}/news/${newsId}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Details failed' }));
    throw new Error(error.error || 'Details failed');
  }

  return res.json();
}

// ============================================
// POLITICIANS
// ============================================

export interface Politician {
  id: number;
  nome_completo: string;
  nome_urna?: string;
  sexo?: string;
  ocupacao?: string;
  grau_instrucao?: string;
  partido_sigla?: string;
  cargo_atual?: string;
  municipio?: string;
  codigo_ibge?: string;
  ano_eleicao?: number;
  eleito?: boolean;
}

export interface PoliticianListResponse {
  success: boolean;
  count: number;
  total?: number;
  politicians: Politician[];
  error?: string;
}

export async function listPoliticians(params?: {
  partido?: string;
  cargo?: string;
  municipio?: string;
  ano_eleicao?: number;
  limit?: number;
  offset?: number;
}): Promise<PoliticianListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.partido) searchParams.append('partido', params.partido);
  if (params?.cargo) searchParams.append('cargo', params.cargo);
  if (params?.municipio) searchParams.append('municipio', params.municipio);
  if (params?.ano_eleicao) searchParams.append('ano_eleicao', String(params.ano_eleicao));
  searchParams.append('limit', String(params?.limit || 50));
  searchParams.append('offset', String(params?.offset || 0));

  const res = await fetch(`${API_BASE}/politicians/list?${searchParams}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'List politicians failed' }));
    throw new Error(error.error || 'List politicians failed');
  }

  return res.json();
}

export async function searchPoliticians(nome: string): Promise<PoliticianListResponse> {
  const res = await fetch(`${API_BASE}/politicians/search?nome=${encodeURIComponent(nome)}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Search politicians failed' }));
    throw new Error(error.error || 'Search politicians failed');
  }

  return res.json();
}

// ============================================
// UTILS
// ============================================

export function formatCnpj(cnpj: string): string {
  if (!cnpj) return '-';
  const c = cnpj.replace(/\D/g, '');
  return c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

export function formatRegime(regime: string | null | undefined): string {
  if (!regime) return '-';
  const map: Record<string, string> = {
    MEI: 'MEI',
    SIMPLES_NACIONAL: 'Simples',
    LUCRO_PRESUMIDO: 'Presumido',
    LUCRO_REAL: 'Real',
    DESCONHECIDO: '?',
  };
  return map[regime] || regime;
}
