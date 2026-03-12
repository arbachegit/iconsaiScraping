import { fetchWithAuth, setTokens } from './auth';

const API_BASE = '/api';

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
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

  const result = await res.json();
  // Store both tokens centrally
  setTokens(result.access_token, result.refresh_token || '');
  return result;
}

export interface UserProfile {
  id: number;
  email: string;
  name: string | null;
  is_admin: boolean;
  role: string;
  permissions: string[];
  is_active: boolean;
  is_verified: boolean;
  profile_complete: boolean;
}

export async function getUser(): Promise<UserProfile> {
  const res = await fetchWithAuth(`${API_BASE}/auth/me`);

  if (!res.ok) {
    throw new Error('Not authenticated');
  }

  return res.json();
}

export interface ProfileCompleteRequest {
  cpf: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento?: string;
  bairro: string;
  cidade: string;
  uf: string;
}

export async function completeProfile(
  data: ProfileCompleteRequest
): Promise<{ success: boolean; message: string; profile_complete: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/auth/profile/complete`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao completar perfil' }));
    throw new Error(error.detail || 'Erro ao completar perfil');
  }

  return res.json();
}

export interface CepResult {
  cep: string;
  state: string;
  city: string;
  neighborhood: string;
  street: string;
}

export async function lookupCep(cep: string): Promise<CepResult> {
  const cleanCep = cep.replace(/\D/g, '');
  const res = await fetch(`https://brasilapi.com.br/api/cep/v2/${cleanCep}`);

  if (!res.ok) {
    throw new Error('CEP nao encontrado');
  }

  return res.json();
}

export interface SetPasswordData {
  token: string;
  password: string;
  cpf?: string;
  cep?: string;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
}

export async function setPassword(
  tokenOrData: string | SetPasswordData,
  password?: string
): Promise<{ success: boolean; message: string; email?: string }> {
  const body = typeof tokenOrData === 'string' ? { token: tokenOrData, password } : tokenOrData;

  const res = await fetch(`${API_BASE}/auth/set-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao definir senha' }));
    const detail = error.detail;
    const message = Array.isArray(detail)
      ? detail.map((e: { msg?: string }) => e.msg).join('; ')
      : detail || 'Erro ao definir senha';
    throw new Error(message);
  }

  return res.json();
}

export async function verifyCode(
  email: string,
  code: string
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Codigo invalido' }));
    throw new Error(error.detail || 'Codigo invalido');
  }

  return res.json();
}

export async function resendCode(
  email: string,
  codeType: string = 'activation'
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/auth/resend-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code_type: codeType }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao reenviar codigo' }));
    throw new Error(error.detail || 'Erro ao reenviar codigo');
  }

  return res.json();
}

export async function recoverPassword(
  email: string
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/auth/recover-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao solicitar recuperacao' }));
    throw new Error(error.detail || 'Erro ao solicitar recuperacao');
  }

  return res.json();
}

export async function resetPassword(
  token: string,
  new_password: string,
  code: string
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, new_password, code }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao redefinir senha' }));
    throw new Error(error.detail || 'Erro ao redefinir senha');
  }

  return res.json();
}

export async function getHealth(): Promise<{ version: string; status: string }> {
  const res = await fetchWithAuth(`${API_BASE}/health`);
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
  today_inserts: number;
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
  value: number;
}

export interface CategoryHistory {
  unit: string;
  timezone: string;
  today: number;
  periodTotal: number;
  points: HistoryPoint[];
}

export interface StatsHistoryResponse {
  success: boolean;
  historico: Record<string, CategoryHistory>;
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
    emendas: number;
    noticias: number;
  };
}

export async function getStatsCurrent(): Promise<StatsCurrentResponse> {
  const res = await fetchWithAuth(`${API_BASE}/stats/current`);
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
  const res = await fetchWithAuth(`${API_BASE}/stats/history?limit=${limit}`);
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
  const res = await fetchWithAuth(`${API_BASE}/stats/snapshot`, {
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
  const res = await fetchWithAuth(`${API_BASE}/stats/current`);
  if (!res.ok) {
    return {
      success: false,
      stats: { empresas: 0, pessoas: 0, politicos: 0, mandatos: 0, emendas: 0, noticias: 0 },
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
      emendas: statsObj.emendas || 0,
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
  const res = await fetchWithAuth(`${API_BASE}/atlas/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
// PEOPLE AGENT CHAT API
// ============================================

export interface PeopleAgentSearchContext {
  query?: string;
  results?: Array<{
    nome_completo?: string;
    cargo_atual?: string | null;
    empresa_atual?: string | null;
    qualityScore?: number;
  }>;
  selectedPerson?: unknown;
}

export interface PeopleAgentChatRequest {
  message: string;
  sessionId?: string;
  searchContext?: PeopleAgentSearchContext;
}

interface PeopleAgentBackendResponse {
  success: boolean;
  sessionId: string;
  response: {
    text: string;
    data?: unknown;
    suggestions?: string[];
  };
  metadata?: {
    intent: string;
    entities: Record<string, string>;
    confidence: number;
    usedLLM: boolean;
    processingTime: number;
  };
  error?: string;
}

export interface PeopleAgentChatResponse {
  text: string;
  sessionId: string;
  data?: unknown;
  suggestions?: string[];
}

export async function peopleAgentChat(
  data: PeopleAgentChatRequest
): Promise<PeopleAgentChatResponse> {
  const res = await fetchWithAuth(`${API_BASE}/people-agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Chat failed' }));
    throw new Error(error.detail || 'Chat failed');
  }

  const result: PeopleAgentBackendResponse = await res.json();

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
  cnae_principal?: string | null;
  cnae_descricao?: string | null;
  descricao_classe?: string | null;
  regime_tributario?: string | null;
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
  const res = await fetchWithAuth(`${API_BASE}/companies/search`, {
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
  natureza_juridica?: string;
  situacao_cadastral?: string;
  capital_social?: number;
  data_abertura?: string;
  logradouro?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  telefone_1?: string;
  telefone_2?: string;
  email?: string;
  website?: string;
  linkedin?: string;
  // Fiscal / Regime tributario
  regime_tributario?: string;
  simples_optante?: boolean;
  simples_desde?: string;
  mei_optante?: boolean;
  mei_desde?: string;
  simples_nacional?: boolean;
  simei?: boolean;
  num_funcionarios?: number;
  setor?: string;
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
  const res = await fetchWithAuth(`${API_BASE}/companies/details`, {
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
  const res = await fetchWithAuth(`${API_BASE}/companies/socios`, {
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
  const res = await fetchWithAuth(`${API_BASE}/companies/approve`, {
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
  cidade?: string | null;
  estado?: string | null;
  cnae_principal?: string | null;
  cnae_descricao?: string | null;
  descricao_classe?: string | null;
  regime_tributario?: string | null;
  linkedin?: string;
  situacao_cadastral?: string;
  fonte?: string | null;
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
  searchParams.append('limit', String(params?.limit || 50));
  searchParams.append('offset', String(params?.offset || 0));

  const res = await fetchWithAuth(`${API_BASE}/companies/list?${searchParams.toString()}`);

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
  const res = await fetchWithAuth(`${API_BASE}/companies/check-existing`, {
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
  const res = await fetchWithAuth(`${API_BASE}/companies/cnae?limit=${limit}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'CNAE list failed' }));
    throw new Error(error.detail || 'CNAE list failed');
  }

  return res.json();
}

// ============================================
// INTELLIGENCE API
// ============================================

export interface IntelligenceQueryRequest {
  query: string;
  context?: {
    company_data?: Record<string, unknown>;
    relationships?: Record<string, unknown>[];
    search_results?: Record<string, unknown>[];
  };
  include_hypotheses?: boolean;
  include_summary?: boolean;
  max_results?: number;
}

export interface IntelligenceHypothesis {
  title: string;
  description: string;
  confidence: number;
  evidence: string[];
  risk_level: string;
  category: string;
  actionable: boolean;
}

export interface IntelligenceResponse {
  success: boolean;
  query: string;
  intent: {
    intent: string;
    confidence: number;
    entities: string[];
    filters: Record<string, string>;
    method: string;
  };
  decomposition: {
    original_query: string;
    sub_queries: { query: string; source: string; priority: number }[];
    strategy: string;
    estimated_steps: number;
  };
  hypotheses?: {
    hypotheses: IntelligenceHypothesis[];
    context_summary: string;
    total_data_points: number;
  };
  summary?: {
    title: string;
    sections: { title: string; content: string; citations: { source: string; claim: string }[] }[];
    key_findings: string[];
    risks: string[];
    opportunities: string[];
    recommendations: string[];
  };
  latency_ms: number;
}

export async function intelligenceQuery(
  data: IntelligenceQueryRequest
): Promise<IntelligenceResponse> {
  const res = await fetchWithAuth(`${API_BASE}/companies/intelligence`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Intelligence query failed' }));
    throw new Error(error.detail || error.error || 'Intelligence query failed');
  }

  return res.json();
}

export async function classifyIntent(query: string): Promise<{
  success: boolean;
  intent: string;
  confidence: number;
  entities: string[];
  method: string;
}> {
  const res = await fetchWithAuth(`${API_BASE}/companies/intelligence/classify`, {
    method: 'POST',
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Classification failed' }));
    throw new Error(error.detail || error.error || 'Classification failed');
  }

  return res.json();
}

export function streamIntelligence(
  query: string,
  onEvent: (event: { stage: string; [key: string]: unknown }) => void,
  onError?: (error: Event) => void
): EventSource {
  const url = `${API_BASE}/../api/intelligence/stream?q=${encodeURIComponent(query)}`;
  const eventSource = new EventSource(url);

  const stages = ['intent', 'decomposition', 'hypotheses', 'summary', 'complete', 'error'];

  for (const stage of stages) {
    eventSource.addEventListener(stage, (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
        if (stage === 'complete' || stage === 'error') {
          eventSource.close();
        }
      } catch {
        // Ignore parse errors
      }
    });
  }

  eventSource.onerror = (error) => {
    eventSource.close();
    onError?.(error);
  };

  return eventSource;
}

// ============================================
// HYBRID SEARCH API
// ============================================

export interface HybridSearchRequest {
  query: string;
  mode?: 'text' | 'vector' | 'relational' | 'hybrid';
  filters?: { cidade?: string; estado?: string };
  limit?: number;
}

export interface HybridSearchResult {
  id: number;
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  cidade: string | null;
  estado: string | null;
  rrf_score: number;
  text_score?: number;
  vector_score?: number;
  relational_score?: number;
  sources: string[];
  final_rank: number;
  sis_score?: number;
}

export interface HybridSearchResponse {
  success: boolean;
  query: string;
  mode: string;
  total: number;
  results: HybridSearchResult[];
  signals: { text: number; vector: number; relational: number };
  timing: Record<string, number>;
  durationMs: number;
}

export interface SISResponse {
  success: boolean;
  empresa_id: string;
  text_similarity: number;
  geo_proximity: number;
  cnae_similarity: number;
  political_connections: number;
  news_volume: number;
  relationship_density: number;
  sis_score: number;
  durationMs: number;
}

export async function hybridSearchCompanies(
  data: HybridSearchRequest
): Promise<HybridSearchResponse> {
  const res = await fetchWithAuth(`${API_BASE}/companies/search/hybrid`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Hybrid search failed' }));
    throw new Error(error.detail || error.error || 'Hybrid search failed');
  }

  return res.json();
}

export interface StreamSearchEvent {
  stage: string;
  timestamp: string;
  count?: number;
  results?: HybridSearchResult[];
  durationMs?: number;
  total?: number;
  timing?: Record<string, number>;
}

/**
 * Stream search via SSE. Returns an EventSource that emits progressive results.
 * Call .close() on the returned EventSource to cancel.
 */
export function streamSearch(
  query: string,
  onEvent: (event: StreamSearchEvent) => void,
  onError?: (error: Event) => void,
  params?: { limit?: number; cidade?: string; estado?: string }
): EventSource {
  const searchParams = new URLSearchParams({ q: query });
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.cidade) searchParams.set('cidade', params.cidade);
  if (params?.estado) searchParams.set('estado', params.estado);

  const url = `${API_BASE}/companies/search/stream?${searchParams.toString()}`;
  const eventSource = new EventSource(url);

  const stages = [
    'connected',
    'db_results',
    'vector_results',
    'graph_results',
    'external_search',
    'enrichment',
    'sis_scores',
    'complete',
    'error',
  ];

  for (const stage of stages) {
    eventSource.addEventListener(stage, (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
        if (stage === 'complete' || stage === 'error') {
          eventSource.close();
        }
      } catch {
        // Ignore parse errors
      }
    });
  }

  eventSource.onerror = (error) => {
    eventSource.close();
    onError?.(error);
  };

  return eventSource;
}

export async function getCompanySIS(companyId: string | number): Promise<SISResponse> {
  const res = await fetchWithAuth(`${API_BASE}/companies/${companyId}/sis`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch SIS' }));
    throw new Error(error.detail || error.error || 'Failed to fetch SIS');
  }

  return res.json();
}

// ============================================
// GRAPH / NETWORK API
// ============================================

export interface GraphRelationship {
  id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  tipo_relacao: string;
  strength: number;
  confidence: number;
  bidirecional: boolean;
  descricao: string | null;
  direction: 'outgoing' | 'incoming';
  neighbor_type: string;
  neighbor_id: string;
}

export interface GraphNode {
  id: string;
  type: string;
  hop: number;
  label: string;
  cnpj?: string;
  cidade?: string;
  estado?: string;
  cargo?: string;
  empresa?: string;
  partido?: string;
  fonte?: string;
}

export interface GraphEdge {
  id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  tipo_relacao: string;
  strength: number;
  confidence: number;
  effective_strength: number;
  effective_confidence: number;
  hop: number;
}

export interface RelationshipsResponse {
  success: boolean;
  empresa_id: string;
  relationships: GraphRelationship[];
  total: number;
  durationMs: number;
}

export interface NetworkResponse {
  success: boolean;
  empresa_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    total_nodes: number;
    total_edges: number;
    max_hop_reached: number;
    by_type: Record<string, number>;
    by_relationship: Record<string, number>;
  };
  durationMs: number;
}

export interface NetworkStatsResponse {
  success: boolean;
  empresa_id: string;
  total_relationships: number;
  by_type: Record<string, number>;
  by_entity_type: Record<string, number>;
  avg_strength: number;
  avg_confidence: number;
  durationMs: number;
}

export async function getCompanyRelationships(
  companyId: string | number,
  params?: { tipo_relacao?: string; min_strength?: number; limit?: number }
): Promise<RelationshipsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.tipo_relacao) searchParams.set('tipo_relacao', params.tipo_relacao);
  if (params?.min_strength) searchParams.set('min_strength', String(params.min_strength));
  if (params?.limit) searchParams.set('limit', String(params.limit));

  const qs = searchParams.toString();
  const url = `${API_BASE}/companies/${companyId}/relationships${qs ? `?${qs}` : ''}`;
  const res = await fetchWithAuth(url);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch relationships' }));
    throw new Error(error.detail || error.error || 'Failed to fetch relationships');
  }

  return res.json();
}

export async function getCompanyNetwork(
  companyId: string | number,
  params?: { hops?: number; limit?: number }
): Promise<NetworkResponse> {
  const searchParams = new URLSearchParams();
  if (params?.hops) searchParams.set('hops', String(params.hops));
  if (params?.limit) searchParams.set('limit', String(params.limit));

  const qs = searchParams.toString();
  const url = `${API_BASE}/companies/${companyId}/network${qs ? `?${qs}` : ''}`;
  const res = await fetchWithAuth(url);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch network' }));
    throw new Error(error.detail || error.error || 'Failed to fetch network');
  }

  return res.json();
}

export async function getCompanyNetworkStats(
  companyId: string | number
): Promise<NetworkStatsResponse> {
  const res = await fetchWithAuth(`${API_BASE}/companies/${companyId}/network-stats`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch network stats' }));
    throw new Error(error.detail || error.error || 'Failed to fetch network stats');
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

  const res = await fetchWithAuth(`${API_BASE}/people/list?${searchParams.toString()}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'List failed' }));
    throw new Error(error.error || 'List failed');
  }

  return res.json();
}

export async function searchPeople(nome: string): Promise<PersonListResponse> {
  const res = await fetchWithAuth(`${API_BASE}/people/search`, {
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
  const res = await fetchWithAuth(`${API_BASE}/people/${personId}`);

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
  telefone?: string;
  headline?: string;
  senioridade?: string;
  departamento?: string;
  twitter_url?: string;
  raw_apollo_data?: Record<string, unknown>;
  _provider?: string;
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
  const res = await fetchWithAuth(`${API_BASE}/people/search-cpf`, {
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
  const res = await fetchWithAuth(`${API_BASE}/people/credit-bureaus`);

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
  const res = await fetchWithAuth(`${API_BASE}/people/save`, {
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
  telefone?: string;
  headline?: string;
  senioridade?: string;
  departamento?: string;
  twitter_url?: string;
  raw_apollo_data?: Record<string, unknown>;
  _source?: 'db' | 'external';
  _provider?: string;
  qualityScore?: number;
  qualityLabel?: 'high' | 'medium';
  enrichedFields?: string[];
}

export interface QualityGateResult {
  enabled: boolean;
  processedCount: number;
  filteredCount: number;
  totalBeforeFilter: number;
  durationMs: number;
}

export interface PeopleSearchV2Response {
  success: boolean;
  guardrail: GuardrailResult;
  needsRefinement?: boolean;
  chatGreeting?: string | null;
  suggestions?: string[];
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
  qualityGate?: QualityGateResult;
  sources_tried: string[];
  requestId: string;
  durationMs: number;
  error?: string;
}

export async function searchPeopleV2(
  data: PeopleSearchV2Request,
  signal?: AbortSignal
): Promise<PeopleSearchV2Response> {
  const res = await fetchWithAuth(`${API_BASE}/people/search-v2`, {
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

export interface PeopleRefineRequest {
  nome: string;
  cidadeUf?: string;
  empresa?: string;
  dataNascimento?: string;
  page?: number;
  pageSize?: number;
}

export interface PeopleRefineResponse {
  success: boolean;
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

export async function refinePeopleSearch(
  data: PeopleRefineRequest,
  signal?: AbortSignal
): Promise<PeopleRefineResponse> {
  const res = await fetchWithAuth(`${API_BASE}/people/search-v2-refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Refine search failed' }));
    throw new Error(error.error || 'Refine search failed');
  }

  return res.json();
}

export interface PeopleEnrichedRow {
  id: string;
  nome: string;
  empresa: string;
  cidade: string;
  estado: string;
  cnae: string;
  descricao: string;
  cnae_descricao: string;
  email: string;
  phone: string;
  telefone: string;
}

export interface PeopleListEnrichedResponse {
  success: boolean;
  count: number;
  people: PeopleEnrichedRow[];
}

export async function listPeopleEnriched(
  search?: string,
  limit = 200,
  offset = 0
): Promise<PeopleListEnrichedResponse> {
  const params = new URLSearchParams();
  if (search && search.trim().length >= 2) params.set('search', search.trim());
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const res = await fetchWithAuth(`${API_BASE}/people/list-enriched?${params.toString()}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'List enriched failed' }));
    throw new Error(error.error || 'List enriched failed');
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
  const res = await fetchWithAuth(`${API_BASE}/people/check-existing`, {
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

export async function savePeopleBatch(
  data: PeopleSaveBatchRequest
): Promise<PeopleSaveBatchResponse> {
  const res = await fetchWithAuth(`${API_BASE}/people/save-batch`, {
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
  const res = await fetchWithAuth(`${API_BASE}/news/sources/list`);

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
  relevancia_geral?: number;
  data?: string;
  tipo_classificacao?: string;
  credibilidade_score?: number;
  tema_principal?: string;
  segmento?: string;
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

  const res = await fetchWithAuth(`${API_BASE}/news/list?${searchParams.toString()}`);

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

  const res = await fetchWithAuth(`${API_BASE}/news/search-ai?${searchParams.toString()}`);

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
  const res = await fetchWithAuth(`${API_BASE}/news/${newsId}`);

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
  codigo_ibge?: string | number;
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

  const res = await fetchWithAuth(`${API_BASE}/politicians/list?${searchParams}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'List politicians failed' }));
    throw new Error(error.error || 'List politicians failed');
  }

  return res.json();
}

export async function searchPoliticians(nome: string): Promise<PoliticianListResponse> {
  const res = await fetchWithAuth(
    `${API_BASE}/politicians/search?nome=${encodeURIComponent(nome)}`
  );

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Search politicians failed' }));
    throw new Error(error.error || 'Search politicians failed');
  }

  return res.json();
}

export interface PoliticianMandate {
  id: number;
  cargo: string;
  partido_sigla: string;
  partido_nome?: string;
  municipio?: string;
  codigo_ibge?: string | number;
  ano_eleicao: number;
  turno?: number;
  numero_candidato?: number;
  eleito: boolean;
  coligacao?: string;
  situacao_turno?: string;
  data_inicio_mandato?: string;
  data_fim_mandato?: string;
}

export interface PoliticianDetailResponse {
  success: boolean;
  politico: Politician;
  mandatos: PoliticianMandate[];
  error?: string;
}

export async function getPoliticianDetails(id: number): Promise<PoliticianDetailResponse> {
  const res = await fetchWithAuth(`${API_BASE}/politicians/${id}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Politician details failed' }));
    throw new Error(error.error || 'Politician details failed');
  }

  return res.json();
}

// ============================================
// EMENDAS (PARLIAMENTARY AMENDMENTS)
// ============================================

export interface Emenda {
  id: number;
  politico_id?: number;
  autor: string;
  ano: number;
  codigo_emenda?: string;
  numero_emenda?: string;
  tipo_emenda?: string;
  funcao?: string;
  subfuncao?: string;
  localidade?: string;
  codigo_ibge?: number;
  valor_empenhado?: number;
  valor_liquidado?: number;
  valor_pago?: number;
  valor_resto_inscrito?: number;
  valor_resto_cancelado?: number;
  valor_resto_pago?: number;
  created_at?: string;
  // Legacy mapped fields (kept for backward compat)
  descricao?: string;
  valor?: number;
  tipo?: string;
  uf?: string;
  partido?: string;
  area_governo?: string;
}

export interface EmendaListResponse {
  success: boolean;
  count: number;
  emendas: Emenda[];
  error?: string;
}

export interface EmendaDetailResponse {
  success: boolean;
  emenda: Emenda;
  error?: string;
}

export async function listEmendas(params?: {
  autor?: string;
  uf?: string;
  ano?: number;
  tipo?: string;
  limit?: number;
  offset?: number;
}): Promise<EmendaListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.autor) searchParams.append('autor', params.autor);
  if (params?.uf) searchParams.append('uf', params.uf);
  if (params?.ano) searchParams.append('ano', String(params.ano));
  if (params?.tipo) searchParams.append('tipo', params.tipo);
  searchParams.append('limit', String(params?.limit || 50));
  searchParams.append('offset', String(params?.offset || 0));

  const res = await fetchWithAuth(`${API_BASE}/emendas/list?${searchParams.toString()}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'List emendas failed' }));
    throw new Error(error.error || 'List emendas failed');
  }

  return res.json();
}

export async function searchEmendas(q: string, limit?: number): Promise<EmendaListResponse> {
  const searchParams = new URLSearchParams();
  searchParams.append('q', q);
  searchParams.append('limit', String(limit || 50));

  const res = await fetchWithAuth(`${API_BASE}/emendas/search?${searchParams.toString()}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Search emendas failed' }));
    throw new Error(error.error || 'Search emendas failed');
  }

  return res.json();
}

export async function getEmendaDetails(id: number): Promise<EmendaDetailResponse> {
  const res = await fetchWithAuth(`${API_BASE}/emendas/${id}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Emenda details failed' }));
    throw new Error(error.error || 'Emenda details failed');
  }

  return res.json();
}

// ============================================
// EMENDAS AGGREGATION
// ============================================

export interface EmendasAggregation {
  totals: {
    total_emendas: number;
    valor_total_empenhado: number;
    valor_total_pago: number;
    autores_unicos: number;
  };
  by_funcao: Array<{ funcao: string; count: number; valor_total: number }>;
  by_ano: Array<{ ano: number; count: number; valor_total: number }>;
  by_tipo: Array<{ tipo_emenda: string; count: number }>;
  by_localidade: Array<{ localidade: string; count: number; valor_total: number }>;
  top_autores: Array<{ autor: string; count: number; valor_total: number }>;
}

export async function getEmendasAggregation(): Promise<EmendasAggregation> {
  const res = await fetchWithAuth(`${API_BASE}/emendas/aggregation`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Aggregation failed' }));
    throw new Error(error.error || 'Aggregation failed');
  }

  return res.json();
}

// ============================================
// NEWS AGGREGATION
// ============================================

export interface NewsAggregation {
  totals: {
    total_noticias: number;
    ultimos_7_dias: number;
  };
  by_segmento: Array<{ segmento: string; count: number }>;
  by_fonte: Array<{ fonte: string; count: number }>;
  by_classificacao: Array<{ tipo: string; count: number }>;
  by_tema: Array<{ tema: string; count: number }>;
  credibilidade: { alta: number; media: number; baixa: number };
}

export async function getNewsAggregation(): Promise<NewsAggregation> {
  const res = await fetchWithAuth(`${API_BASE}/news/aggregation`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Aggregation failed' }));
    throw new Error(error.error || 'Aggregation failed');
  }

  return res.json();
}

// ============================================
// ADMIN - USER MANAGEMENT API
// ============================================

export interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  phone: string;
  cpf: string;
  is_admin: boolean;
  role: string;
  permissions: string[];
  is_active: boolean;
  is_verified: boolean;
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
}

export interface AdminListUsersResponse {
  users: AdminUser[];
}

export interface AdminCreateUserRequest {
  name: string;
  email: string;
  password: string;
  permissions: string[];
  role?: string;
}

export interface AdminCreateUserResponse {
  success: boolean;
  user: AdminUser;
}

export interface AdminUpdateUserRequest {
  name?: string;
  email?: string;
  phone?: string;
  cpf?: string;
  cep?: string;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  permissions?: string[];
  role?: string;
  is_active?: boolean;
  new_password?: string;
}

export interface AdminUpdateUserResponse {
  success: boolean;
  user: AdminUser;
}

export interface AdminCreateUserFlowRequest {
  name: string;
  email: string;
  phone: string;
  role?: string;
  permissions?: string[];
}

export interface AdminCreateUserFlowResponse {
  success: boolean;
  user_id: number;
  email: string;
  message: string;
}

export async function adminListUsers(): Promise<AdminListUsersResponse> {
  const res = await fetchWithAuth(`${API_BASE}/admin/users`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao listar usuarios' }));
    throw new Error(error.detail || 'Erro ao listar usuarios');
  }

  return res.json();
}

export async function adminCreateUser(
  data: AdminCreateUserRequest
): Promise<AdminCreateUserResponse> {
  const res = await fetchWithAuth(`${API_BASE}/admin/users`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao criar usuario' }));
    throw new Error(error.detail || 'Erro ao criar usuario');
  }

  return res.json();
}

export async function adminCreateUserFlow(
  data: AdminCreateUserFlowRequest
): Promise<AdminCreateUserFlowResponse> {
  const res = await fetchWithAuth(`${API_BASE}/admin/users/invite`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao criar usuario' }));
    throw new Error(error.detail || 'Erro ao criar usuario');
  }

  return res.json();
}

export async function adminUpdateUser(
  userId: number,
  data: AdminUpdateUserRequest
): Promise<AdminUpdateUserResponse> {
  const res = await fetchWithAuth(`${API_BASE}/admin/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao atualizar usuario' }));
    throw new Error(error.detail || 'Erro ao atualizar usuario');
  }

  return res.json();
}

export async function adminDeleteUser(
  userId: number
): Promise<{ success: boolean; message: string }> {
  const res = await fetchWithAuth(`${API_BASE}/admin/users/${userId}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao desativar usuario' }));
    throw new Error(error.detail || 'Erro ao desativar usuario');
  }

  return res.json();
}

export async function adminResendInvite(
  userId: number
): Promise<{ success: boolean; message: string }> {
  const res = await fetchWithAuth(`${API_BASE}/admin/users/${userId}/resend-invite`, {
    method: 'POST',
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao reenviar convite' }));
    throw new Error(error.detail || 'Erro ao reenviar convite');
  }

  return res.json();
}

export async function adminPermanentDeleteUser(
  userId: number
): Promise<{ success: boolean; message: string }> {
  const res = await fetchWithAuth(`${API_BASE}/admin/users/${userId}/permanent`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Erro ao excluir usuario' }));
    throw new Error(error.detail || 'Erro ao excluir usuario');
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

// ============================================
// GRAPH VISUALIZATION API
// ============================================

export interface GraphNodeData {
  id: string;
  type: string;
  label: string;
  data?: Record<string, unknown>;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  tipo_relacao: string;
  strength: number;
  label?: string;
}

export interface GraphDataResponse {
  success: boolean;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  total_nodes: number;
  total_edges: number;
}

export interface GraphExpandResponse {
  success: boolean;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  center: { id: string; type: string; label: string } | null;
}

export interface GraphSearchResult {
  id: string;
  type: string;
  label: string;
  subtitle?: string;
}

export async function getGraphData(params?: {
  limit?: number;
  entity_type?: string;
}): Promise<GraphDataResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.entity_type) searchParams.set('entity_type', params.entity_type);
  const qs = searchParams.toString();

  const res = await fetchWithAuth(`${API_BASE}/graph/data${qs ? `?${qs}` : ''}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch graph data' }));
    throw new Error(error.detail || error.error || 'Failed to fetch graph data');
  }

  return res.json();
}

export async function expandGraphNode(
  entityType: string,
  entityId: string
): Promise<GraphExpandResponse> {
  const res = await fetchWithAuth(`${API_BASE}/graph/expand/${entityType}/${entityId}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to expand node' }));
    throw new Error(error.detail || error.error || 'Failed to expand node');
  }

  return res.json();
}

export async function searchGraphEntities(
  query: string,
  limit = 10
): Promise<{ success: boolean; results: GraphSearchResult[] }> {
  const res = await fetchWithAuth(
    `${API_BASE}/graph/search?q=${encodeURIComponent(query)}&limit=${limit}`
  );

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Graph search failed' }));
    throw new Error(error.detail || error.error || 'Graph search failed');
  }

  return res.json();
}

export async function getGraphPath(
  sourceType: string,
  sourceId: string,
  targetType: string,
  targetId: string
): Promise<GraphDataResponse> {
  const res = await fetchWithAuth(
    `${API_BASE}/graph/path/${sourceType}/${sourceId}/${targetType}/${targetId}`
  );

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to find path' }));
    throw new Error(error.detail || error.error || 'Failed to find path');
  }

  return res.json();
}

export interface GraphExploreResponse {
  success: boolean;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  center: { id: string; type: string; label: string } | null;
  stats: {
    total_nodes: number;
    total_edges: number;
    empresas: number;
    socios: number;
    noticias: number;
    politicos: number;
    emendas: number;
    mandatos: number;
  };
  message?: string;
}

export async function exploreGraph(
  query: string,
  params?: { entityType?: string; entityId?: string }
): Promise<GraphExploreResponse> {
  const searchParams = new URLSearchParams();
  if (query.trim() !== '') searchParams.set('q', query.trim());
  if (params?.entityType) searchParams.set('entity_type', params.entityType);
  if (params?.entityId) searchParams.set('entity_id', params.entityId);

  const qs = searchParams.toString();
  const res = await fetchWithAuth(`${API_BASE}/graph/explore${qs ? `?${qs}` : ''}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Graph explore failed' }));
    throw new Error(error.detail || error.error || 'Graph explore failed');
  }

  return res.json();
}

export interface GraphStatsResponse {
  success: boolean;
  total_nodes: number;
  total_edges: number;
  nodes_by_type: Record<string, number>;
  edges_by_type: Record<string, number>;
}

export async function getGraphStats(): Promise<GraphStatsResponse> {
  const res = await fetchWithAuth(`${API_BASE}/graph/stats`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch graph stats' }));
    throw new Error(error.detail || error.error || 'Failed to fetch graph stats');
  }

  return res.json();
}

// ============================================
// DEEP SEARCH API
// ============================================

export interface DeepSearchNode {
  id: string;
  type: string;
  label: string;
  hop: number;
  data: {
    subtitle?: string;
    sources: string[];
    sourceCount: number;
    confidence: number;
    evidenceScore: number;
    relevance: number;
    [key: string]: unknown;
  };
}

export interface DeepSearchEdge {
  id: string;
  source: string;
  target: string;
  tipo_relacao: string;
  strength: number;
  label: string;
}

export interface DeepSearchResponse {
  success: boolean;
  query: string;
  nodes: DeepSearchNode[];
  edges: DeepSearchEdge[];
  center: null;
  stats: {
    total_nodes: number;
    total_edges: number;
    empresas: number;
    socios: number;
    noticias: number;
    politicos: number;
    emendas: number;
    mandatos: number;
  };
}

export async function deepSearchGraph(
  query: string,
): Promise<DeepSearchResponse> {
  const res = await fetchWithAuth(
    `${API_BASE}/graph/deep-search?q=${encodeURIComponent(query)}`,
  );

  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ detail: 'Deep search failed' }));
    throw new Error(error.detail || error.error || 'Deep search failed');
  }

  return res.json();
}

// ============================================
// DATABASE MODEL API
// ============================================

export interface DbModelDomainSummary {
  domain: string;
  label: string;
  color: string;
  tableCount: number;
  visibleCount: number;
}

export interface DbModelTableSummary {
  id: string;
  schema: string;
  name: string;
  friendlyName: string;
  description: string;
  domain: string;
  domainLabel: string;
  domainColor: string;
  isHiddenByDefault: boolean;
  columnCount: number;
  foreignKeyCount: number;
  requiredColumnCount: number;
  primaryKey: string | null;
  estimatedRowCount: number;
  countMode: 'estimated';
}

export interface DbModelRelationship {
  id: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
}

export interface DbModelOverviewResponse {
  success: boolean;
  generatedAt: string;
  countMode: 'estimated';
  tables: DbModelTableSummary[];
  relationships: DbModelRelationship[];
  domains: DbModelDomainSummary[];
  stats: {
    totalTables: number;
    defaultVisibleTables: number;
    hiddenTables: number;
    totalRelationships: number;
  };
}

export interface DbModelColumnDetail {
  tableName: string;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: unknown;
  description: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  references: {
    table: string;
    column: string;
  } | null;
  nonNullCount: number;
  coverageRatio: number | null;
}

export interface DbModelTableDetailResponse {
  success: boolean;
  countMode: 'estimated';
  table: DbModelTableSummary & {
    columns: DbModelColumnDetail[];
    outgoingRelationships: DbModelRelationship[];
    incomingRelationships: DbModelRelationship[];
  };
}

export async function getDbModelOverview(): Promise<DbModelOverviewResponse> {
  const res = await fetchWithAuth(`${API_BASE}/db-model/overview`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch DB model overview' }));
    throw new Error(error.detail || error.error || 'Failed to fetch DB model overview');
  }

  return res.json();
}

export async function getDbModelTableDetails(
  tableName: string
): Promise<DbModelTableDetailResponse> {
  const res = await fetchWithAuth(`${API_BASE}/db-model/table/${encodeURIComponent(tableName)}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch table details' }));
    throw new Error(error.detail || error.error || 'Failed to fetch table details');
  }

  return res.json();
}

export interface DbModelTableSamplesResponse {
  success: boolean;
  tableName: string;
  samples: Record<string, string | null>;
}

export async function getDbModelTableSamples(
  tableName: string
): Promise<DbModelTableSamplesResponse> {
  const res = await fetchWithAuth(
    `${API_BASE}/db-model/table/${encodeURIComponent(tableName)}/samples`
  );

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Failed to fetch table samples' }));
    throw new Error(error.detail || error.error || 'Failed to fetch table samples');
  }

  return res.json();
}

// ============================================
// GRAPH NODE DETAILS API
// ============================================

export interface CnaeDetails {
  codigo: string;
  descricao: string;
  secao?: string;
  descricao_secao?: string;
  divisao?: string;
  descricao_divisao?: string;
  grupo?: string;
  descricao_grupo?: string;
  classe?: string;
  descricao_classe?: string;
}

export interface RegimeTributarioRecord {
  regime_tributario?: string;
  porte?: string;
  natureza_juridica?: string;
  capital_social?: number;
  cnae_principal?: string;
  cnae_descricao?: string;
  setor?: string;
  descricao?: string;
  qtd_funcionarios?: number;
  data_inicio?: string;
  data_fim?: string;
  ativo?: boolean;
  simples_optante?: boolean;
  simples_desde?: string;
  mei_optante?: boolean;
  mei_desde?: string;
  raw_cnpja?: Record<string, unknown>;
  data_registro?: string;
}

export interface GraphNodeDetailsResponse {
  success: boolean;
  empresa: CompanyDetails;
  regime: RegimeTributarioRecord | null;
  regimes: RegimeTributarioRecord[];
  cnae: CnaeDetails | null;
  socios: Socio[];
}

export async function getGraphNodeDetails(empresaId: string): Promise<GraphNodeDetailsResponse> {
  const res = await fetchWithAuth(`${API_BASE}/graph/node-details/empresa/${empresaId}`);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to fetch node details' }));
    throw new Error(error.error || 'Failed to fetch node details');
  }

  return res.json();
}

// ============================================
// BI API
// ============================================

export interface BiProfile {
  cnae: {
    cnae_principal: string | null;
    setor_economico: string | null;
    cadeia_valor: string | null;
    posicao_cadeia: string | null;
    cnaes_clientes_tipicos: string[];
    cnaes_fornecedores_tipicos: string[];
    total_empresas_mesmo_cnae_municipio: number | null;
    total_empresas_mesmo_cnae_estado: number | null;
    ranking_municipal: number | null;
    ranking_estadual: number | null;
  } | null;
  tributario: {
    regime_tributario: string | null;
    porte: string | null;
    faturamento_estimado_min: number | null;
    faturamento_estimado_max: number | null;
    score_saude_fiscal: number | null;
    perfil_comprador: string | null;
    poder_compra_estimado: string | null;
    idade_empresa_anos: number | null;
    quantidade_funcionarios_estimado: number | null;
  } | null;
  geografico: {
    arco_atuacao: string | null;
    densidade_concorrentes: number | null;
    indice_saturacao: number | null;
    populacao_alcancavel: number | null;
    oportunidades_geograficas: { cidades_oportunidade?: Array<{ cidade: string; concorrentes_cnae: number }> } | null;
  } | null;
}

export interface BiOpportunity {
  id: string;
  nome_alvo: string | null;
  tipo_oportunidade: string;
  score_oportunidade: number;
  score_geografico: number | null;
  score_cnae: number | null;
  score_tributario: number | null;
  score_temporal: number | null;
  score_evidencia: number | null;
  lead_temperatura: string | null;
  lead_score: number | null;
  prioridade: string;
  justificativa: string | null;
  acoes_recomendadas: string[] | null;
}

export async function getBiProfile(empresaId: string): Promise<BiProfile> {
  const res = await fetchWithAuth(`${API_BASE}/bi/profile/${empresaId}`);
  if (!res.ok) throw new Error('Failed to fetch BI profile');
  const json = await res.json();
  return json.data;
}

export async function getBiOpportunities(empresaId: string): Promise<BiOpportunity[]> {
  const res = await fetchWithAuth(`${API_BASE}/bi/opportunities/${empresaId}?limit=10`);
  if (!res.ok) throw new Error('Failed to fetch BI opportunities');
  const json = await res.json();
  return json.data || [];
}

export async function triggerBiPipeline(empresaId: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/bi/pipeline/${empresaId}`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to trigger BI pipeline');
}

// ═══════════════ Pipeline Orchestrator API ═══════════════

export interface PipelinePhaseStatus {
  key: string;
  label: string;
  order: number;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface PipelineRun {
  id: string;
  runId?: string;
  empresa_id: string;
  status: 'running' | 'completed' | 'completed_with_errors' | 'error';
  started_at: string;
  completed_at: string | null;
  total_duration_ms: number | null;
  phases: Record<string, PipelinePhaseStatus>;
  summary: {
    empresa: string;
    cnpj: string;
    phases_success: number;
    phases_error: number;
    phases_skipped: number;
    total_duration_ms: number;
    profiles: { cnae: boolean; tributario: boolean; geografico: boolean };
    crawl: string;
    taxonomy: string | null;
    evidencias_total: number;
    oportunidades_total: number;
    oportunidades_quentes: number;
    grafo_relacoes: number;
  } | null;
}

export interface PipelinePhaseDefinition {
  key: string;
  label: string;
  order: number;
}

export async function getPipelinePhases(): Promise<PipelinePhaseDefinition[]> {
  const res = await fetchWithAuth(`${API_BASE}/pipeline/phases`);
  if (!res.ok) throw new Error('Failed to fetch pipeline phases');
  const json = await res.json();
  return json.data;
}

export async function executePipeline(
  empresaId: string,
  options: {
    skip_crawl?: boolean;
    skip_graph?: boolean;
    force_crawl?: boolean;
    only_phases?: string[];
  } = {},
): Promise<PipelineRun> {
  const res = await fetchWithAuth(`${API_BASE}/pipeline/execute/${empresaId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!res.ok) throw new Error('Failed to execute pipeline');
  const json = await res.json();
  return json.data;
}

export async function getPipelineStatus(runId: string): Promise<PipelineRun> {
  const res = await fetchWithAuth(`${API_BASE}/pipeline/status/${runId}`);
  if (!res.ok) throw new Error('Failed to fetch pipeline status');
  const json = await res.json();
  return json.data;
}

export async function getPipelineHistory(empresaId: string): Promise<PipelineRun[]> {
  const res = await fetchWithAuth(`${API_BASE}/pipeline/history/${empresaId}`);
  if (!res.ok) throw new Error('Failed to fetch pipeline history');
  const json = await res.json();
  return json.data || [];
}

// ═══════════════ BI Ecosystem API ═══════════════

export interface EcosystemRelation {
  id: string;
  empresa_id: string;
  empresa_relacionada_id: string | null;
  nome_empresa_relacionada: string;
  cnpj_relacionada: string | null;
  tipo_relacao: string;
  subtipo: string | null;
  confianca: number;
  fonte_deteccao: string;
  evidencia: string | null;
}

export interface EcosystemData {
  confirmados: {
    clientes: EcosystemRelation[];
    fornecedores: EcosystemRelation[];
    concorrentes: EcosystemRelation[];
    parceiros: EcosystemRelation[];
  };
  potenciais_cnae: {
    clientes: Array<{ id: string; razao_social: string; cidade: string }>;
    fornecedores: Array<{ id: string; razao_social: string; cidade: string }>;
    concorrentes: Array<{ id: string; razao_social: string; cidade: string }>;
  };
  total: number;
}

export async function getBiEcosystem(empresaId: string): Promise<EcosystemData> {
  const res = await fetchWithAuth(`${API_BASE}/bi/ecosystem/${empresaId}`);
  if (!res.ok) throw new Error('Failed to fetch ecosystem');
  const json = await res.json();
  return json.data;
}

export async function getBiLeads(
  empresaId: string,
  temperatura?: string,
): Promise<BiOpportunity[]> {
  const params = temperatura ? `?temperatura=${temperatura}` : '';
  const res = await fetchWithAuth(`${API_BASE}/bi/opportunities/${empresaId}/leads${params}`);
  if (!res.ok) throw new Error('Failed to fetch leads');
  const json = await res.json();
  return json.data || [];
}

export async function triggerBiScoring(empresaId: string): Promise<BiOpportunity[]> {
  const res = await fetchWithAuth(`${API_BASE}/bi/score/${empresaId}`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to trigger scoring');
  const json = await res.json();
  return json.data || [];
}

export interface BiContext {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  tabelas_requeridas: string[];
  ativo: boolean;
}

export async function getBiContexts(): Promise<BiContext[]> {
  const res = await fetchWithAuth(`${API_BASE}/bi/contexts`);
  if (!res.ok) throw new Error('Failed to fetch contexts');
  const json = await res.json();
  return json.data || [];
}

export interface TaxonomyNode {
  id: string;
  codigo: string;
  nome: string;
  nivel: number;
  segmentos?: TaxonomyNode[];
}

export async function getBiTaxonomy(): Promise<TaxonomyNode[]> {
  const res = await fetchWithAuth(`${API_BASE}/bi/taxonomy`);
  if (!res.ok) throw new Error('Failed to fetch taxonomy');
  const json = await res.json();
  return json.data || [];
}

export async function triggerBiCrawl(empresaId: string, force = false): Promise<unknown> {
  const res = await fetchWithAuth(`${API_BASE}/bi/crawl/${empresaId}?force=${force}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to trigger crawl');
  const json = await res.json();
  return json.data;
}

export interface BiEvidence {
  id: string;
  entidade_origem_type: string;
  entidade_origem_id: string;
  entidade_destino_type: string | null;
  entidade_destino_id: string | null;
  tipo_evidencia: string;
  fonte: string;
  confianca: number;
  texto_evidencia: string | null;
  created_at: string;
}

export async function getBiEvidence(
  entityType: string,
  entityId: string,
): Promise<{ data: BiEvidence[]; aggregate_confidence: number }> {
  const res = await fetchWithAuth(`${API_BASE}/bi/evidence/${entityType}/${entityId}`);
  if (!res.ok) throw new Error('Failed to fetch evidence');
  const json = await res.json();
  return { data: json.data || [], aggregate_confidence: json.aggregate_confidence || 0 };
}

// ═══════════════ Reports API ═══════════════

export interface ReportTemplate {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  categoria: string;
  template_sections: Array<{ key: string; titulo: string; tipo: string }>;
}

export interface ReportSection {
  key: string;
  titulo: string;
  tipo: string;
  data: unknown;
}

export interface GeneratedReport {
  id: string;
  titulo: string;
  resumo: string | null;
  sections: ReportSection[];
  metricas: Record<string, unknown>;
  score_geral: number | null;
  graph_analytics: Record<string, unknown> | null;
  status: string;
  created_at: string;
  template?: string;
  dim_relatorios?: { codigo: string; nome: string; categoria: string };
}

export interface ReportListItem {
  id: string;
  titulo: string;
  resumo: string | null;
  score_geral: number | null;
  status: string;
  created_at: string;
  dim_relatorios: { codigo: string; nome: string; categoria: string } | null;
}

export interface GraphAnalytics {
  summary: {
    total_nodes: number;
    total_edges: number;
    total_communities: number;
    total_bridges: number;
    avg_strength: number;
    avg_confidence: number;
    relationship_types: Record<string, number>;
  };
  root_metrics: {
    degree: number;
    betweenness: number;
    pagerank: number;
    closeness: number;
    community: number;
    direct_connections: number;
  };
  top_influencers: Array<{
    key: string;
    type: string;
    id: string;
    score: number;
    degree: number;
    betweenness: number;
    pagerank: number;
  }>;
  communities: Array<{
    id: number;
    size: number;
    members: Array<{ type: string; id: string }>;
  }>;
  bridges: Array<{
    from: { type: string; id: string };
    to: { type: string; id: string };
  }>;
  duration_ms: number;
}

export async function getReportCatalog(): Promise<ReportTemplate[]> {
  const res = await fetchWithAuth(`${API_BASE}/reports/catalog`);
  if (!res.ok) throw new Error('Failed to fetch report catalog');
  const json = await res.json();
  return json.data || [];
}

export async function generateReportApi(
  reportCode: string,
  entityType: string,
  entityId: string,
): Promise<GeneratedReport> {
  const res = await fetchWithAuth(`${API_BASE}/reports/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report_code: reportCode, entity_type: entityType, entity_id: entityId }),
  });
  if (!res.ok) throw new Error('Failed to generate report');
  const json = await res.json();
  return json.data;
}

export async function listEntityReports(
  entityType: string,
  entityId: string,
): Promise<ReportListItem[]> {
  const res = await fetchWithAuth(`${API_BASE}/reports/entity/${entityType}/${entityId}`);
  if (!res.ok) throw new Error('Failed to list reports');
  const json = await res.json();
  return json.data || [];
}

export async function getReportById(reportId: string): Promise<GeneratedReport> {
  const res = await fetchWithAuth(`${API_BASE}/reports/${reportId}`);
  if (!res.ok) throw new Error('Failed to fetch report');
  const json = await res.json();
  return json.data;
}

export async function getGraphAnalytics(
  entityType: string,
  entityId: string,
  hops = 2,
): Promise<GraphAnalytics> {
  const res = await fetchWithAuth(`${API_BASE}/reports/analytics/${entityType}/${entityId}?hops=${hops}`);
  if (!res.ok) throw new Error('Failed to fetch graph analytics');
  const json = await res.json();
  return json.data;
}

export async function getInfluenceScore(
  entityType: string,
  entityId: string,
): Promise<{ influence_score: number; degree: number; pagerank: number; connections: number; network_size: number }> {
  const res = await fetchWithAuth(`${API_BASE}/reports/influence/${entityType}/${entityId}`);
  if (!res.ok) throw new Error('Failed to fetch influence score');
  const json = await res.json();
  return json.data;
}
