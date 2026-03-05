import { supabaseRead } from "../database/supabase.js";
import logger from "../utils/logger.js";

const OPENAPI_CACHE_TTL_MS = 5 * 60 * 1000;
const OVERVIEW_CACHE_TTL_MS = 2 * 60 * 1000;
const DETAIL_CACHE_TTL_MS = 2 * 60 * 1000;
const COUNT_CONCURRENCY = 6;

const HIDDEN_BY_DEFAULT = new Set([
  "audit_logs",
  "cep_ibge_mapping",
  "cep_prefix_mapping",
  "dim_date",
  "dim_time",
  "geo_municipios_ref",
  "messaging_logs",
  "raw_simples_rf",
  "refresh_tokens",
  "stats_historico",
  "stg_socios_rf",
  "users",
  "verification_codes",
]);

const TABLE_OVERRIDES = {
  dim_empresas: {
    domain: "empresas",
    friendlyName: "Empresas",
    description:
      "Cadastro mestre de empresas. Concentra identidade, contato e atributos-base usados pelos outros fatos.",
  },
  dim_pessoas: {
    domain: "pessoas",
    friendlyName: "Pessoas",
    description:
      "Cadastro mestre de pessoas relacionadas ao ecossistema analisado, incluindo executivos, socios e perfis enriquecidos.",
  },
  fato_transacao_empresas: {
    domain: "empresas",
    friendlyName: "Movimentacoes Societarias",
    description:
      "Liga pessoas e empresas em eventos societarios, cargos e transacoes de entrada ou saida.",
  },
  fato_regime_tributario: {
    domain: "empresas",
    friendlyName: "Regime Tributario",
    description:
      "Historico tributario das empresas, com porte, natureza juridica, CNAE e evolucao do enquadramento.",
  },
  fato_inferencia_limites: {
    domain: "empresas",
    friendlyName: "Inferencia de Limites",
    description:
      "Camada analitica com inferencias de faturamento e mudanca provavel de regime.",
  },
  dim_regimes_tributarios: {
    domain: "referencia",
    friendlyName: "Catalogo de Regimes",
    description:
      "Dicionario com os tipos de regime tributario usados pelas tabelas factuais.",
  },
  raw_cnae: {
    domain: "referencia",
    friendlyName: "CNAE Oficial",
    description:
      "Tabela de referencia de CNAEs oficiais. Serve como vocabulario padrao de atividade economica.",
  },
  dim_fontes_noticias: {
    domain: "noticias",
    friendlyName: "Fontes de Noticias",
    description:
      "Catalogo dos veiculos e fontes jornalisticas usados na coleta e vinculacao das noticias.",
  },
  dim_noticias: {
    domain: "noticias",
    friendlyName: "Noticias",
    description:
      "Cadastro das noticias capturadas, com texto, metadata editorial e origem.",
  },
  fato_noticias_empresas: {
    domain: "noticias",
    friendlyName: "Noticias x Empresas",
    description:
      "Tabela de relacionamento que conecta noticias as empresas mencionadas ou afetadas.",
  },
  fato_noticias_topicos: {
    domain: "noticias",
    friendlyName: "Noticias x Topicos",
    description:
      "Classifica as noticias por topicos, permitindo navegacao tematica e filtros analiticos.",
  },
  fato_pessoas: {
    domain: "pessoas",
    friendlyName: "Fatos de Pessoas",
    description:
      "Relaciona pessoas a noticias, temas, politicos e fontes para consolidar contexto e enriquecimento.",
  },
  dim_tema_pessoas: {
    domain: "pessoas",
    friendlyName: "Temas de Pessoas",
    description:
      "Dicionario dos temas ou contextos usados para categorizar fatos ligados a pessoas.",
  },
  fato_relacoes_entidades: {
    domain: "grafo",
    friendlyName: "Relacoes do Grafo",
    description:
      "Motor do grafo de entidades. Registra as ligacoes entre empresas, pessoas, noticias e outros nos.",
  },
  fontes_dados: {
    domain: "referencia",
    friendlyName: "Fontes de Dados",
    description:
      "Catalogo institucional das origens de dados utilizadas nas coletas, enriquecimentos e inferencias.",
  },
  dim_politicos: {
    domain: "politica",
    friendlyName: "Politicos",
    description:
      "Cadastro mestre de politicos. Funciona como entidade principal do dominio politico.",
  },
  dim_parlamentares_externos: {
    domain: "politica",
    friendlyName: "Parlamentares Externos",
    description:
      "Ponte entre o cadastro interno de politicos e fontes parlamentares externas.",
  },
  dim_sessoes_votacao: {
    domain: "politica",
    friendlyName: "Sessoes de Votacao",
    description:
      "Agenda e metadados das sessoes legislativas que servem de base para os votos registrados.",
  },
  fato_bens_candidato: {
    domain: "politica",
    friendlyName: "Bens Declarados",
    description:
      "Historico de bens declarados por candidatos e politicos no dominio eleitoral.",
  },
  fato_receitas_campanha: {
    domain: "politica",
    friendlyName: "Receitas de Campanha",
    description:
      "Fluxo de entradas financeiras de campanha vinculadas aos politicos.",
  },
  fato_votos_legislativos: {
    domain: "politica",
    friendlyName: "Votos Legislativos",
    description:
      "Registro dos votos emitidos por politicos em sessoes legislativas especificas.",
  },
  users: {
    domain: "governanca",
    friendlyName: "Usuarios",
    description:
      "Tabela operacional de usuarios, perfis e atributos de autenticacao do sistema.",
  },
  verification_codes: {
    domain: "governanca",
    friendlyName: "Codigos de Verificacao",
    description:
      "Controle temporario de codigos enviados para ativacao, verificacao e recuperacao.",
  },
  refresh_tokens: {
    domain: "governanca",
    friendlyName: "Refresh Tokens",
    description:
      "Persistencia de refresh tokens de sessao para renovacao de acesso.",
  },
  audit_logs: {
    domain: "governanca",
    friendlyName: "Auditoria",
    description:
      "Trilha de auditoria de operacoes sensiveis, recursos afetados e estados antes/depois.",
  },
  messaging_logs: {
    domain: "governanca",
    friendlyName: "Mensageria",
    description:
      "Historico tecnico de mensagens enviadas por canais como WhatsApp, SMS ou email.",
  },
  stats_historico: {
    domain: "governanca",
    friendlyName: "Historico de Stats",
    description:
      "Serie historica para os cards do dashboard e monitoramento do volume dos modulos.",
  },
  dim_date: {
    domain: "governanca",
    friendlyName: "Calendario",
    description: "Dimensao tecnica de datas usada por estruturas analiticas.",
  },
  dim_time: {
    domain: "governanca",
    friendlyName: "Tempo",
    description:
      "Dimensao tecnica de horarios usada por estruturas analiticas.",
  },
  geo_municipios_ref: {
    domain: "referencia",
    friendlyName: "Municipios de Referencia",
    description:
      "Tabela de referencia geografica para normalizacao territorial e enriquecimento.",
  },
  cep_ibge_mapping: {
    domain: "referencia",
    friendlyName: "CEP x IBGE",
    description:
      "Mapa tecnico entre CEPs e codigos IBGE para padronizacao geografica.",
  },
  cep_prefix_mapping: {
    domain: "referencia",
    friendlyName: "Prefixos de CEP",
    description:
      "Referencia tecnica para associar prefixos de CEP a regioes geograficas.",
  },
  raw_simples_rf: {
    domain: "referencia",
    friendlyName: "Raw Simples RF",
    description:
      "Carga bruta de dados da Receita Federal ligados ao Simples Nacional.",
  },
  stg_socios_rf: {
    domain: "referencia",
    friendlyName: "Staging de Socios RF",
    description:
      "Camada intermediaria de socios da Receita Federal antes da consolidacao final.",
  },
};

const DOMAIN_META = {
  empresas: { label: "Empresas", color: "#f97316", order: 10 },
  pessoas: { label: "Pessoas", color: "#fb923c", order: 20 },
  noticias: { label: "Noticias", color: "#22c55e", order: 30 },
  politica: { label: "Politica", color: "#3b82f6", order: 40 },
  grafo: { label: "Grafo", color: "#a855f7", order: 50 },
  referencia: { label: "Referencia", color: "#06b6d4", order: 60 },
  governanca: { label: "Governanca", color: "#64748b", order: 70 },
};

let openApiCache = { value: null, expiresAt: 0 };
let overviewCache = { value: null, expiresAt: 0 };
const detailCache = new Map();

function now() {
  return Date.now();
}

function isCacheValid(cacheEntry) {
  return cacheEntry.value && cacheEntry.expiresAt > now();
}

function titleizeTableName(tableName) {
  return tableName
    .replace(/^(dim|fato|raw|stg|vw)_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function stripMarkup(text) {
  return normalizeWhitespace(
    text
      .replace(/<[^>]+>/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^Note:\s*/i, ""),
  );
}

function cleanColumnDescription(description) {
  if (!description) return null;
  const cleaned = stripMarkup(description);
  if (
    cleaned === "This is a Primary Key." ||
    cleaned.startsWith("This is a Foreign Key to ")
  ) {
    return null;
  }
  return cleaned || null;
}

function detectDomain(tableName) {
  if (TABLE_OVERRIDES[tableName]?.domain) {
    return TABLE_OVERRIDES[tableName].domain;
  }

  if (tableName.startsWith("dim_") || tableName.startsWith("fato_")) {
    return "referencia";
  }

  if (tableName.startsWith("raw_") || tableName.startsWith("stg_")) {
    return "referencia";
  }

  return "governanca";
}

function getTableDescription(tableName) {
  if (TABLE_OVERRIDES[tableName]?.description) {
    return TABLE_OVERRIDES[tableName].description;
  }

  if (tableName.startsWith("dim_")) {
    return "Tabela dimensional com entidades principais e atributos relativamente estaveis do dominio.";
  }

  if (tableName.startsWith("fato_")) {
    return "Tabela factual que registra eventos, relacoes ou medições conectadas as entidades principais.";
  }

  if (tableName.startsWith("raw_")) {
    return "Camada bruta de ingestao, preservando a estrutura de origem antes da normalizacao.";
  }

  if (tableName.startsWith("stg_")) {
    return "Camada intermediaria de staging usada para consolidacao e limpeza antes do modelo final.";
  }

  return "Tabela de apoio do sistema.";
}

function getTableMetadata(tableName) {
  const override = TABLE_OVERRIDES[tableName] || {};
  const domain = detectDomain(tableName);
  const domainMeta = DOMAIN_META[domain] || DOMAIN_META.governanca;

  return {
    domain,
    domainLabel: domainMeta.label,
    domainColor: domainMeta.color,
    order: domainMeta.order,
    friendlyName: override.friendlyName || titleizeTableName(tableName),
    description: getTableDescription(tableName),
    isHiddenByDefault: HIDDEN_BY_DEFAULT.has(tableName),
  };
}

function parseColumn(tableName, columnName, rawMeta = {}, requiredColumns) {
  const description =
    typeof rawMeta.description === "string" ? rawMeta.description : "";
  const fkMatch = description.match(/<fk table='([^']+)' column='([^']+)'\/>/);
  const isPrimaryKey = description.includes("<pk/>");

  return {
    tableName,
    name: columnName,
    type: rawMeta.format || rawMeta.type || "unknown",
    nullable: !requiredColumns.has(columnName),
    defaultValue: rawMeta.default ?? null,
    description: cleanColumnDescription(description),
    isPrimaryKey,
    isForeignKey: Boolean(fkMatch),
    references: fkMatch
      ? {
          table: fkMatch[1],
          column: fkMatch[2],
        }
      : null,
  };
}

function buildTableDefinition(tableName, rawDefinition) {
  const requiredColumns = new Set(rawDefinition.required || []);
  const properties = rawDefinition.properties || {};
  const columns = Object.entries(properties)
    .map(([columnName, columnMeta]) =>
      parseColumn(tableName, columnName, columnMeta, requiredColumns),
    )
    .sort((left, right) => {
      if (left.isPrimaryKey !== right.isPrimaryKey)
        return left.isPrimaryKey ? -1 : 1;
      if (left.isForeignKey !== right.isForeignKey)
        return left.isForeignKey ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  const primaryKey =
    columns.find((column) => column.isPrimaryKey)?.name ||
    columns[0]?.name ||
    null;
  const tableMeta = getTableMetadata(tableName);

  return {
    id: `public.${tableName}`,
    schema: "public",
    name: tableName,
    friendlyName: tableMeta.friendlyName,
    description: tableMeta.description,
    domain: tableMeta.domain,
    domainLabel: tableMeta.domainLabel,
    domainColor: tableMeta.domainColor,
    order: tableMeta.order,
    isHiddenByDefault: tableMeta.isHiddenByDefault,
    columnCount: columns.length,
    foreignKeyCount: columns.filter((column) => column.isForeignKey).length,
    requiredColumnCount: requiredColumns.size,
    primaryKey,
    columns,
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function runWorker() {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, Math.max(items.length, 1)) },
    () => runWorker(),
  );

  await Promise.all(workers);
  return results;
}

async function fetchOpenApiSpec() {
  if (isCacheValid(openApiCache)) {
    return openApiCache.value;
  }

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      Accept: "application/openapi+json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("db_model_openapi_fetch_failed", {
      status: response.status,
      body: body.slice(0, 300),
    });
    throw new Error("Failed to fetch database catalog");
  }

  const spec = await response.json();
  openApiCache = {
    value: spec,
    expiresAt: now() + OPENAPI_CACHE_TTL_MS,
  };

  return spec;
}

async function getTableDefinitions() {
  const spec = await fetchOpenApiSpec();
  const definitions = spec.definitions || {};

  return Object.entries(definitions)
    .filter(([tableName]) => !tableName.startsWith("vw_"))
    .map(([tableName, rawDefinition]) =>
      buildTableDefinition(tableName, rawDefinition),
    )
    .sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order;
      if (left.isHiddenByDefault !== right.isHiddenByDefault)
        return left.isHiddenByDefault ? 1 : -1;
      return left.name.localeCompare(right.name);
    });
}

async function estimateTableRowCount(table) {
  const selectColumn = table.primaryKey || table.columns[0]?.name || "*";
  return countRows(table.name, selectColumn);
}

function buildRelationships(tables) {
  const availableTables = new Set(tables.map((table) => table.name));
  const relationships = [];

  for (const table of tables) {
    for (const column of table.columns) {
      if (!column.references || !availableTables.has(column.references.table))
        continue;

      relationships.push({
        id: `${table.name}.${column.name}->${column.references.table}.${column.references.column}`,
        sourceTable: table.name,
        sourceColumn: column.name,
        targetTable: column.references.table,
        targetColumn: column.references.column,
      });
    }
  }

  return relationships;
}

function summarizeTable(table, estimatedRowCount) {
  return {
    id: table.id,
    schema: table.schema,
    name: table.name,
    friendlyName: table.friendlyName,
    description: table.description,
    domain: table.domain,
    domainLabel: table.domainLabel,
    domainColor: table.domainColor,
    isHiddenByDefault: table.isHiddenByDefault,
    columnCount: table.columnCount,
    foreignKeyCount: table.foreignKeyCount,
    requiredColumnCount: table.requiredColumnCount,
    primaryKey: table.primaryKey,
    estimatedRowCount,
    countMode: "estimated",
  };
}

async function countRows(tableName, selectColumn, options = {}) {
  const {
    filterColumn = null,
    warnKey = "db_model_table_count_failed",
    warnContext = { table: tableName },
  } = options;

  const countModes = ["estimated", "planned", "exact"];
  let lastFailure = null;

  for (const countMode of countModes) {
    let query = supabaseRead.from(tableName).select(selectColumn, {
      head: true,
      count: countMode,
    });

    if (filterColumn) {
      query = query.not(filterColumn, "is", null);
    }

    const { count, error, status, statusText } = await query;

    if (!error && typeof count === "number") {
      return count;
    }

    lastFailure = {
      countMode,
      status,
      statusText,
      error: error?.message || null,
    };
  }

  logger.warn(warnKey, {
    ...warnContext,
    ...lastFailure,
  });

  return 0;
}

export async function getDbModelOverview() {
  if (isCacheValid(overviewCache)) {
    return overviewCache.value;
  }

  const tables = await getTableDefinitions();
  const estimatedCounts = await mapWithConcurrency(
    tables,
    COUNT_CONCURRENCY,
    (table) => estimateTableRowCount(table),
  );
  const relationships = buildRelationships(tables);

  const summarizedTables = tables.map((table, index) =>
    summarizeTable(table, estimatedCounts[index] || 0),
  );

  const domainSummary = Object.values(
    summarizedTables.reduce((accumulator, table) => {
      if (!accumulator[table.domain]) {
        accumulator[table.domain] = {
          domain: table.domain,
          label: table.domainLabel,
          color: table.domainColor,
          tableCount: 0,
          visibleCount: 0,
        };
      }

      accumulator[table.domain].tableCount += 1;
      if (!table.isHiddenByDefault) {
        accumulator[table.domain].visibleCount += 1;
      }

      return accumulator;
    }, {}),
  ).sort((left, right) => {
    const leftOrder = DOMAIN_META[left.domain]?.order || 999;
    const rightOrder = DOMAIN_META[right.domain]?.order || 999;
    return leftOrder - rightOrder;
  });

  const overview = {
    success: true,
    generatedAt: new Date().toISOString(),
    countMode: "estimated",
    tables: summarizedTables,
    relationships,
    domains: domainSummary,
    stats: {
      totalTables: summarizedTables.length,
      defaultVisibleTables: summarizedTables.filter(
        (table) => !table.isHiddenByDefault,
      ).length,
      hiddenTables: summarizedTables.filter((table) => table.isHiddenByDefault)
        .length,
      totalRelationships: relationships.length,
    },
  };

  overviewCache = {
    value: overview,
    expiresAt: now() + OVERVIEW_CACHE_TTL_MS,
  };

  return overview;
}

function buildIncomingRelationships(allTables, tableName) {
  const incoming = [];

  for (const table of allTables) {
    for (const column of table.columns) {
      if (!column.references || column.references.table !== tableName) continue;

      incoming.push({
        id: `${table.name}.${column.name}->${tableName}.${column.references.column}`,
        sourceTable: table.name,
        sourceColumn: column.name,
        targetTable: tableName,
        targetColumn: column.references.column,
      });
    }
  }

  return incoming.sort((left, right) => {
    const tableCompare = left.sourceTable.localeCompare(right.sourceTable);
    if (tableCompare !== 0) return tableCompare;
    return left.sourceColumn.localeCompare(right.sourceColumn);
  });
}

function sortDetailedColumns(columns) {
  return [...columns].sort((left, right) => {
    if (left.isPrimaryKey !== right.isPrimaryKey)
      return left.isPrimaryKey ? -1 : 1;
    if (left.isForeignKey !== right.isForeignKey)
      return left.isForeignKey ? -1 : 1;
    if (left.nullable !== right.nullable) return left.nullable ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
}

export async function getDbModelTableDetails(tableName) {
  const cached = detailCache.get(tableName);
  if (cached && cached.expiresAt > now()) {
    return cached.value;
  }

  const tables = await getTableDefinitions();
  const table = tables.find((item) => item.name === tableName);

  if (!table) {
    return null;
  }

  const estimatedRowCount = await estimateTableRowCount(table);
  const selectColumn = table.primaryKey || table.columns[0]?.name || "*";

  const columns = await mapWithConcurrency(
    table.columns,
    COUNT_CONCURRENCY,
    async (column) => {
      const nonNullCount = await countRows(table.name, selectColumn, {
        filterColumn: column.name,
        warnKey: "db_model_column_count_failed",
        warnContext: {
          table: table.name,
          column: column.name,
        },
      });

      return {
        ...column,
        nonNullCount,
        coverageRatio:
          estimatedRowCount > 0 ? nonNullCount / estimatedRowCount : null,
      };
    },
  );

  const tableDetails = {
    success: true,
    countMode: "estimated",
    table: {
      ...summarizeTable(table, estimatedRowCount),
      columns: sortDetailedColumns(columns),
      outgoingRelationships: buildRelationships([table]),
      incomingRelationships: buildIncomingRelationships(tables, table.name),
    },
  };

  detailCache.set(tableName, {
    value: tableDetails,
    expiresAt: now() + DETAIL_CACHE_TTL_MS,
  });

  return tableDetails;
}
