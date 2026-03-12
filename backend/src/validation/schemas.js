/**
 * Zod validation schemas for API endpoints
 * CLAUDE.md Rule: "✅ ALWAYS: Validação com Zod (TS) ou Pydantic (Python)"
 */
import { z } from 'zod';

// CNPJ validation (14 digits)
const cnpjSchema = z.string()
  .transform(val => val.replace(/[^\d]/g, ''))
  .refine(val => val.length === 14, { message: 'CNPJ deve ter 14 dígitos' });

// Company search request - mínimo 1 campo preenchido + pagination
export const searchCompanySchema = z.object({
  nome: z.string()
    .max(200, 'Nome deve ter no máximo 200 caracteres')
    .transform(val => val?.trim())
    .optional()
    .nullable(),
  cidade: z.string()
    .max(100)
    .transform(val => val?.trim())
    .optional()
    .nullable(),
  segmento: z.string()
    .max(200)
    .transform(val => val?.trim())
    .optional()
    .nullable(),
  regime: z.string()
    .max(100)
    .transform(val => val?.trim())
    .optional()
    .nullable(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25)
}).refine(data => {
  // Contar campos preenchidos com pelo menos 2 caracteres
  const campos = [data.nome, data.cidade, data.segmento, data.regime];
  const preenchidos = campos.filter(c => c && c.length >= 2).length;
  return preenchidos >= 1;
}, {
  message: 'Preencha pelo menos 1 campo para buscar'
});

// Company details request
export const detailsCompanySchema = z.object({
  cnpj: cnpjSchema
});

// Socios enrichment request
export const sociosSchema = z.object({
  socios: z.array(z.object({
    nome: z.string().min(1),
    cpf: z.string().optional().nullable(),
    cargo: z.string().optional().nullable(),
    qualificacao: z.string().optional().nullable(),
    data_entrada: z.string().optional().nullable(),
    faixa_etaria: z.string().optional().nullable(),
    pais_origem: z.string().optional().nullable()
  })).min(1, 'Lista de sócios é obrigatória'),
  empresa_nome: z.string().optional()
});

// Company approval request
export const approveCompanySchema = z.object({
  empresa: z.object({
    cnpj: cnpjSchema,
    razao_social: z.string().min(1),
    nome_fantasia: z.string().optional().nullable(),
    situacao_cadastral: z.string().optional().nullable(),
    data_abertura: z.string().optional().nullable(),
    logradouro: z.string().optional().nullable(),
    numero: z.string().optional().nullable(),
    complemento: z.string().optional().nullable(),
    bairro: z.string().optional().nullable(),
    cidade: z.string().optional().nullable(),
    estado: z.string().optional().nullable(),
    cep: z.string().optional().nullable(),
    codigo_municipio_ibge: z.string().optional().nullable(),
    telefone_1: z.string().optional().nullable(),
    telefone_2: z.string().optional().nullable(),
    email: z.string().email().optional().nullable(),
    website: z.string().url().optional().nullable(),
    linkedin: z.string().url().optional().nullable(),
    logo_url: z.string().url().optional().nullable(),
    twitter: z.string().url().optional().nullable(),
    facebook: z.string().url().optional().nullable(),
    instagram: z.string().url().optional().nullable(),
    porte: z.string().optional().nullable(),
    natureza_juridica: z.string().optional().nullable(),
    capital_social: z.number().optional().nullable(),
    cnae_principal: z.string().optional().nullable(),
    cnae_descricao: z.string().optional().nullable(),
    regime_tributario: z.string().optional().nullable(),
    setor: z.string().optional().nullable(),
    descricao: z.string().optional().nullable(),
    num_funcionarios: z.union([z.string(), z.number()]).optional().nullable(),
    simples_optante: z.boolean().optional().nullable(),
    simples_desde: z.string().optional().nullable(),
    mei_optante: z.boolean().optional().nullable(),
    mei_desde: z.string().optional().nullable(),
    historico_regimes: z.array(z.any()).optional().nullable(),
    qtd_mudancas_regime: z.number().optional().nullable(),
    raw_brasilapi: z.any().optional(),
    raw_apollo: z.any().optional(),
    raw_cnpja: z.any().optional()
  }),
  socios: z.array(z.any()).optional().nullable(),
  aprovado_por: z.string().min(1, 'Aprovador é obrigatório')
});

// Company list query params (GET /list)
export const listCompaniesSchema = z.object({
  nome: z.string().max(200).transform(val => val?.trim()).optional(),
  cidade: z.string().max(100).transform(val => val?.trim()).optional(),
  segmento: z.string().max(200).transform(val => val?.trim()).optional(),
  regime: z.string().max(100).transform(val => val?.trim()).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// VAR recalculation request
export const recalculateSchema = z.object({
  qtd_funcionarios: z.number().int().min(0).optional(),
  capital_social: z.number().min(0).optional()
});

// UUID param validation
export const uuidParamSchema = z.object({
  id: z.string().uuid('ID inválido')
});

// Integer ID param validation (for politicians)
export const integerIdParamSchema = z.object({
  id: z.coerce.number().int().positive('ID deve ser um número positivo')
});

// ============================================
// POLITICIANS SCHEMAS
// ============================================

// Safe string for SQL queries (prevents SQL injection via ilike)
const safeStringSchema = z.string()
  .max(200)
  .transform(val => val?.trim())
  .refine(val => !val || !/[%_\\]/.test(val), {
    message: 'Caracteres especiais não permitidos'
  });

// Código IBGE (7 dígitos)
const codigoIbgeSchema = z.string()
  .regex(/^\d{7}$/, 'Código IBGE deve ter 7 dígitos');

// Sigla de partido (2-10 letras maiúsculas)
const partidoSiglaSchema = z.string()
  .min(2).max(10)
  .transform(val => val?.toUpperCase())
  .refine(val => /^[A-Z]+$/.test(val), {
    message: 'Sigla deve conter apenas letras'
  });

// Ano de eleição (1990-2030)
const anoEleicaoSchema = z.coerce
  .number()
  .int()
  .min(1990, 'Ano mínimo: 1990')
  .max(2030, 'Ano máximo: 2030');

// Politicians list query params
export const politiciansListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  partido: partidoSiglaSchema.optional(),
  cargo: safeStringSchema.optional(),
  municipio: safeStringSchema.optional(),
  ano_eleicao: anoEleicaoSchema.optional()
});

// Politicians search query params
export const politiciansSearchSchema = z.object({
  nome: safeStringSchema
    .refine(val => val && val.length >= 2, {
      message: 'Nome deve ter pelo menos 2 caracteres'
    })
});

// Politicians by municipality params
export const politicosByMunicipioSchema = z.object({
  codigoIbge: codigoIbgeSchema
});

// Politicians by municipality query
export const politicosByMunicipioQuerySchema = z.object({
  eleitos: z.enum(['true', 'false']).optional().default('true'),
  ano: anoEleicaoSchema.optional()
});

// Politicians by party params
export const politicosByPartidoSchema = z.object({
  sigla: partidoSiglaSchema
});

// Politicians by party query
export const politicosByPartidoQuerySchema = z.object({
  cargo: safeStringSchema.optional(),
  ano_eleicao: anoEleicaoSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

/**
 * Validate request query with Zod schema
 * @param {z.ZodSchema} schema - Zod schema to validate against
 * @returns {Function} Express middleware
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    try {
      const validated = schema.parse(req.query);
      // Express v5: req.query is a read-only getter — use defineProperty to override
      Object.defineProperty(req, 'query', {
        value: validated,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: 'Query params inválidos',
          details: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }
      next(error);
    }
  };
}

/**
 * Validate request body with Zod schema
 * @param {z.ZodSchema} schema - Zod schema to validate against
 * @returns {Function} Express middleware
 */
export function validateBody(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: 'Dados inválidos',
          details: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }
      next(error);
    }
  };
}

/**
 * Validate request params with Zod schema
 * @param {z.ZodSchema} schema - Zod schema to validate against
 * @returns {Function} Express middleware
 */
export function validateParams(schema) {
  return (req, res, next) => {
    try {
      req.params = schema.parse(req.params);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Parâmetros inválidos',
          details: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }
      next(error);
    }
  };
}

// ============================================
// GRAPH / NETWORK SCHEMAS
// ============================================

// Entity type enum
const entityTypeSchema = z.enum(['empresa', 'pessoa', 'politico', 'mandato', 'emenda', 'noticia']);

// Relationship type enum
const relationshipTypeSchema = z.enum([
  'societaria', 'fornecedor', 'concorrente', 'parceiro', 'regulador',
  'beneficiario', 'mencionado_em', 'cnae_similar', 'geografico', 'politico_empresarial',
  'emenda_beneficiario', 'mandato'
]);

// Hybrid search request (POST /search/hybrid)
export const hybridSearchSchema = z.object({
  query: z.string()
    .min(2, 'Query deve ter pelo menos 2 caracteres')
    .max(500, 'Query muito longa')
    .transform(val => val.trim()),
  mode: z.enum(['text', 'vector', 'relational', 'hybrid']).default('hybrid'),
  filters: z.object({
    cidade: z.string().max(100).optional(),
    estado: z.string().max(2).optional()
  }).optional().default({}),
  limit: z.coerce.number().int().min(1).max(50).default(25)
});

// Stream search query params (GET /search/stream)
export const streamSearchSchema = z.object({
  q: z.string()
    .min(2, 'Query deve ter pelo menos 2 caracteres')
    .max(500)
    .transform(val => val.trim()),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cidade: z.string().max(100).optional(),
  estado: z.string().max(2).optional()
});

// Network query params (GET /:id/network)
export const networkQuerySchema = z.object({
  hops: z.coerce.number().int().min(1).max(3).default(2),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  tipo_relacao: relationshipTypeSchema.optional(),
  min_strength: z.coerce.number().min(0).max(1).optional()
});

// Direct relationships query params (GET /:id/relationships)
export const relationshipsQuerySchema = z.object({
  tipo_relacao: relationshipTypeSchema.optional(),
  min_strength: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

// ============================================
// ATLAS CHAT SCHEMAS
// ============================================

// CPF validation (11 digits) - optional
const cpfSchemaOptional = z.string()
  .transform(val => val.replace(/[^\d]/g, ''))
  .refine(val => val.length === 0 || val.length === 11, { message: 'CPF deve ter 11 dígitos' })
  .optional()
  .nullable();

// Person search request - at least CPF or nome required
export const searchPersonByCpfSchema = z.object({
  cpf: cpfSchemaOptional,
  nome: z.string().max(200).optional().nullable()
}).refine(data => {
  const hasCpf = data.cpf && data.cpf.length === 11;
  const hasNome = data.nome && data.nome.trim().length >= 2;
  return hasCpf || hasNome;
}, {
  message: 'Preencha pelo menos CPF ou nome (mínimo 2 caracteres)'
});

// Atlas chat request validation
export const atlasChatSchema = z.object({
  message: z.string()
    .min(1, 'Mensagem não pode estar vazia')
    .max(1000, 'Mensagem muito longa (máximo 1000 caracteres)')
    .transform(val => val.trim()),
  sessionId: z.string().uuid().optional().nullable()
});

// Atlas clear session request
export const atlasClearSessionSchema = z.object({
  sessionId: z.string().uuid('Session ID inválido')
});

// ============================================
// PEOPLE V2 SCHEMAS
// ============================================

// Person search v2 - with guardrail support
export const searchPersonV2Schema = z.object({
  searchType: z.enum(['cpf', 'nome'], { required_error: 'searchType é obrigatório (cpf ou nome)' }),
  cpf: z.string()
    .transform(val => val.replace(/[^\d]/g, ''))
    .refine(val => val.length === 0 || val.length === 11, { message: 'CPF deve ter 11 dígitos' })
    .optional()
    .nullable(),
  nome: z.string().max(200).transform(val => val?.trim()).optional().nullable(),
  dataNascimento: z.string().max(20).transform(val => val?.trim()).optional().nullable(),
  cidadeUf: z.string().max(100).transform(val => val?.trim()).optional().nullable(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100)
}).refine(data => {
  if (data.searchType === 'cpf') {
    return data.cpf && data.cpf.length === 11;
  }
  return data.nome && data.nome.length >= 2;
}, {
  message: 'Para busca por CPF informe 11 dígitos, para busca por nome informe mínimo 2 caracteres'
});

// ============================================
// PEOPLE AGENT SCHEMAS
// ============================================

// People Agent chat request validation
export const peopleAgentChatSchema = z.object({
  message: z.string()
    .min(1, 'Mensagem não pode estar vazia')
    .max(1000, 'Mensagem muito longa (máximo 1000 caracteres)')
    .transform(val => val.trim()),
  sessionId: z.string().uuid().optional().nullable(),
  searchContext: z.object({
    query: z.string().max(200).optional(),
    results: z.array(z.object({
      nome_completo: z.string().optional(),
      cargo_atual: z.string().optional().nullable(),
      empresa_atual: z.string().optional().nullable(),
      qualityScore: z.number().optional(),
    }).passthrough()).max(10).optional(),
    selectedPerson: z.any().optional()
  }).optional().nullable()
});

// People Agent clear session request
export const peopleAgentClearSessionSchema = z.object({
  sessionId: z.string().uuid('Session ID inválido')
});

// ============================================
// NEWS SCHEMAS
// ============================================

// News search query params (GET /api/news/search)
export const newsSearchSchema = z.object({
  q: z.string()
    .min(1, 'Query "q" é obrigatória')
    .max(300, 'Query muito longa (máximo 300 caracteres)')
    .transform(val => val.trim()),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

// People list query params (GET /api/people/list)
export const peopleListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// News list query params (GET /api/news/list)
export const newsListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  segmento: z.string().max(100).transform(val => val?.trim()).optional()
});

// News classify batch body (POST /api/news/classify-batch)
export const newsClassifyBatchSchema = z.object({
  maxBatches: z.coerce.number().int().min(1).max(100).default(10),
  batchSize: z.coerce.number().int().min(5).max(50).default(25),
});

// News enrich batch body (POST /api/news/enrich-batch)
export const newsEnrichBatchSchema = z.object({
  maxBatches: z.coerce.number().int().min(1).max(100).default(10),
  batchSize: z.coerce.number().int().min(5).max(30).default(15),
});

// ============================================
// EMENDAS SCHEMAS
// ============================================

// Emendas list query params (GET /api/emendas/list)
export const listEmendasSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  autor: safeStringSchema.optional(),
  uf: z.string()
    .max(2)
    .transform(val => val?.toUpperCase())
    .refine(val => !val || /^[A-Z]{2}$/.test(val), {
      message: 'UF deve ter 2 letras'
    })
    .optional(),
  ano: z.coerce
    .number()
    .int()
    .min(2000, 'Ano minimo: 2000')
    .max(2030, 'Ano maximo: 2030')
    .optional(),
  tipo: safeStringSchema.optional()
});

// Emendas search query params (GET /api/emendas/search)
export const searchEmendasSchema = z.object({
  q: z.string()
    .min(2, 'Query deve ter pelo menos 2 caracteres')
    .max(300, 'Query muito longa (maximo 300 caracteres)')
    .transform(val => val.trim()),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

// ============================================
// NEWS AI SEARCH SCHEMA
// ============================================

// News AI search query params (GET /api/news/search-ai)
export const newsSearchAiSchema = z.object({
  q: z.string()
    .min(1, 'Query "q" é obrigatória')
    .max(300, 'Query muito longa (máximo 300 caracteres)')
    .transform(val => val.trim()),
  fonte: z.string().max(100).transform(val => val?.trim()).optional().nullable(),
  idioma: z.enum(['pt', 'en', 'es']).default('pt'),
  pais: z.string().max(5).default('BR'),
  data_inicio: z.string().max(20).optional().nullable(),
  data_fim: z.string().max(20).optional().nullable(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

// ============================================
// PEOPLE ENRICHED LIST SCHEMA
// ============================================

// People list-enriched query params (GET /api/people/list-enriched)
export const peopleListEnrichedSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(200).transform(val => val?.trim()).optional().default(''),
});

// ============================================
// BI QUERY SCHEMAS
// ============================================

// BI opportunities query params (GET /api/bi/opportunities/:empresaId)
export const biOpportunitiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['quente', 'morno', 'frio', 'todos']).optional(),
});

// BI leads query params (GET /api/bi/opportunities/:empresaId/leads)
export const biLeadsQuerySchema = z.object({
  temperatura: z.enum(['quente', 'morno', 'frio']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// BI evidence query params
export const biEvidenceQuerySchema = z.object({
  tipo: z.string().max(50).transform(val => val?.trim()).optional(),
  fonte: z.string().max(100).transform(val => val?.trim()).optional(),
  min_confianca: z.coerce.number().min(0).max(1).optional(),
});

// ============================================
// PEOPLE BATCH SCHEMAS
// ============================================

// Batch save people
export const saveBatchSchema = z.object({
  pessoas: z.array(z.object({
    cpf: z.string().optional().nullable(),
    nome_completo: z.string().min(1, 'nome_completo é obrigatório'),
    cargo_atual: z.string().optional().nullable(),
    empresa_atual: z.string().optional().nullable(),
    linkedin_url: z.string().url().optional().nullable(),
    email: z.string().email().optional().nullable(),
    localizacao: z.string().optional().nullable(),
    resumo_profissional: z.string().optional().nullable(),
    foto_url: z.string().url().optional().nullable(),
    telefone: z.string().optional().nullable(),
    headline: z.string().optional().nullable(),
    senioridade: z.string().optional().nullable(),
    departamento: z.string().optional().nullable(),
    twitter_url: z.string().url().optional().nullable(),
    raw_apollo_data: z.record(z.string(), z.unknown()).optional().nullable(),
    _provider: z.string().optional().nullable(),
  })).min(1, 'Mínimo 1 pessoa').max(100, 'Máximo 100 pessoas por lote'),
  aprovado_por: z.string().min(1, 'aprovado_por é obrigatório')
});
