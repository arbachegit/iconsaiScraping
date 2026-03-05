#!/usr/bin/env bash
set -uo pipefail

# =============================================
# OTIMIZACAO dim_empresas (64M+ rows)
# Executa via psql direto, sem timeout
#
# USO:
#   chmod +x scripts/run_optimize_dim_empresas.sh
#   ./scripts/run_optimize_dim_empresas.sh
#
# IMPORTANTE: Gera credenciais via Supabase CLI (supabase login obrigatorio)
# =============================================

echo "=========================================="
echo "OTIMIZACAO dim_empresas - $(date)"
echo "=========================================="

# ------------------------------------------
# OBTER CREDENCIAIS via Supabase CLI
# ------------------------------------------
echo "[1/10] Obtendo credenciais via Supabase CLI..."

DUMP_OUTPUT=$(supabase db dump --dry-run 2>&1)

export PGHOST=$(echo "$DUMP_OUTPUT" | grep 'export PGHOST=' | head -1 | sed 's/export PGHOST="//' | sed 's/"//')
export PGPORT=$(echo "$DUMP_OUTPUT" | grep 'export PGPORT=' | head -1 | sed 's/export PGPORT="//' | sed 's/"//')
export PGUSER=$(echo "$DUMP_OUTPUT" | grep 'export PGUSER=' | head -1 | sed 's/export PGUSER="//' | sed 's/"//')
export PGPASSWORD=$(echo "$DUMP_OUTPUT" | grep 'export PGPASSWORD=' | head -1 | sed 's/export PGPASSWORD="//' | sed 's/"//')
export PGDATABASE=$(echo "$DUMP_OUTPUT" | grep 'export PGDATABASE=' | head -1 | sed 's/export PGDATABASE="//' | sed 's/"//')

if [ -z "$PGHOST" ] || [ -z "$PGPASSWORD" ]; then
  echo "ERRO: Nao foi possivel obter credenciais. Execute 'supabase login' primeiro."
  exit 1
fi

echo "  Host: $PGHOST"
echo "  User: $PGUSER"
echo "  DB:   $PGDATABASE"

# Funcao helper: executa SQL com role postgres e sem timeout
run_sql() {
  local desc="$1"
  local sql="$2"
  echo ""
  echo ">>> $desc"
  psql -c "SET SESSION ROLE postgres; SET statement_timeout = '0'; $sql" 2>&1
  echo "  OK"
}

# Funcao para CREATE INDEX CONCURRENTLY (nao pode ter SET na mesma transacao)
# psql em autocommit mode: cada -c eh uma transacao separada
run_index() {
  local desc="$1"
  local sql="$2"
  echo ""
  echo ">>> $desc"
  echo "  (pode levar 5-15 minutos para 64M rows...)"
  local start=$(date +%s)
  # Primeiro SET role e timeout, depois CREATE INDEX CONCURRENTLY separado
  psql -c "SET SESSION ROLE postgres;" -c "SET statement_timeout = '0';" -c "$sql" 2>&1
  local end=$(date +%s)
  echo "  Concluido em $((end - start))s"
}

# ------------------------------------------
# FASE 1: VERIFICACAO INICIAL
# ------------------------------------------
echo ""
echo "=========================================="
echo "[2/10] VERIFICACAO INICIAL"
echo "=========================================="

run_sql "Contagem estimada de rows" \
  "SELECT reltuples::bigint AS estimated_rows, pg_size_pretty(pg_total_relation_size('dim_empresas')) AS total_size FROM pg_class WHERE relname = 'dim_empresas';"

run_sql "Indexes atuais" \
  "SELECT indexname, pg_size_pretty(pg_relation_size(schemaname || '.' || indexname)) AS size FROM pg_indexes WHERE tablename = 'dim_empresas' ORDER BY pg_relation_size(schemaname || '.' || indexname) DESC;"

# ------------------------------------------
# FASE 2: DROP INDEXES INUTEIS
# ------------------------------------------
echo ""
echo "=========================================="
echo "[3/10] DROP INDEXES INUTEIS (~7 GB liberados)"
echo "=========================================="

# dim_empresas_cnpj_unique eh DUPLICATA de dim_empresas_cnpj_key (constraint)
# O _key eh a constraint, o _unique eh standalone. Dropar o standalone.
run_sql "Drop index duplicado cnpj_unique (3.4 GB)" \
  "DROP INDEX IF EXISTS dim_empresas_cnpj_unique;"

# text_pattern_ops: so serve para LIKE 'prefix%', NAO para ILIKE '%substring%'
# 0 scans registrados = nunca usado
run_sql "Drop index razao_social_pat UNUSED (1.9 GB)" \
  "DROP INDEX IF EXISTS idx_dim_empresas_razao_social_pat;"

# upper(nome_fantasia) text_pattern_ops: 0 scans, nunca usado
run_sql "Drop index nome_fantasia_upper UNUSED (1.1 GB)" \
  "DROP INDEX IF EXISTS idx_dim_empresas_nome_fantasia_upper;"

# nome_fantasia text_pattern_ops: 1 scan total, praticamente inutil
# Sera substituido pelo GIN trigram
run_sql "Drop index nome_fantasia_pat (1.1 GB, substituido por GIN)" \
  "DROP INDEX IF EXISTS idx_dim_empresas_nome_fantasia_pat;"

# cidade btree: 0 scans, app usa ILIKE que nao usa btree
# Sera substituido por composite (cidade, estado)
run_sql "Drop index cidade btree UNUSED (802 MB)" \
  "DROP INDEX IF EXISTS idx_dim_empresas_cidade;"

run_sql "Espaco liberado - verificar" \
  "SELECT pg_size_pretty(pg_total_relation_size('dim_empresas')) AS total_size_after;"

# ------------------------------------------
# FASE 3: CREATE GIN TRIGRAM INDEXES
# ------------------------------------------
echo ""
echo "=========================================="
echo "[4/10] CREATE GIN TRIGRAM INDEXES"
echo "=========================================="
echo "NOTA: Cada index leva ~6-8 minutos em 64M rows."
echo "      pg_trgm ja esta habilitado (v1.6)."

run_index "GIN trigram em razao_social" \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_razao_trgm ON dim_empresas USING gin(razao_social gin_trgm_ops);"

run_index "GIN trigram em nome_fantasia" \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_nome_trgm ON dim_empresas USING gin(nome_fantasia gin_trgm_ops);"

# ------------------------------------------
# FASE 4: COMPOSITE + PARTIAL INDEXES
# ------------------------------------------
echo ""
echo "=========================================="
echo "[5/10] COMPOSITE + PARTIAL INDEXES"
echo "=========================================="

run_index "Index composto (cidade, estado)" \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_cidade_estado ON dim_empresas(cidade, estado);"

run_index "Index em created_at DESC (paginacao)" \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_created_at ON dim_empresas(created_at DESC);"

run_index "Partial index empresas ATIVAS" \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_ativas ON dim_empresas(id) WHERE situacao_cadastral = 'ATIVA';"

run_index "Index composto (situacao_cadastral, estado)" \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_situacao_estado ON dim_empresas(situacao_cadastral, estado);"

run_index "Index em cnae_id FK" \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_cnae_id ON dim_empresas(cnae_id) WHERE cnae_id IS NOT NULL;"

# ------------------------------------------
# FASE 5: COVERING INDEX PARA CNPJ LOOKUP
# ------------------------------------------
echo ""
echo "=========================================="
echo "[6/10] COVERING INDEX (evita heap lookup)"
echo "=========================================="

run_index "Covering index cnpj → id, razao_social, nome_fantasia, cidade, estado" \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_cnpj_cover ON dim_empresas(cnpj) INCLUDE (id, razao_social, nome_fantasia, cidade, estado, situacao_cadastral);"

# ------------------------------------------
# FASE 6: RPC FUNCTIONS
# ------------------------------------------
echo ""
echo "=========================================="
echo "[7/10] RPC FUNCTIONS (busca otimizada)"
echo "=========================================="

run_sql "Funcao search_empresas (trigram + ILIKE)" "
CREATE OR REPLACE FUNCTION search_empresas(
    p_query TEXT,
    p_cidade TEXT DEFAULT NULL,
    p_estado TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    cnpj VARCHAR,
    razao_social VARCHAR,
    nome_fantasia VARCHAR,
    cidade VARCHAR,
    estado VARCHAR,
    situacao_cadastral VARCHAR,
    similarity_score REAL
)
LANGUAGE sql STABLE
AS \$\$
    SELECT
        e.id, e.cnpj, e.razao_social, e.nome_fantasia,
        e.cidade, e.estado, e.situacao_cadastral,
        GREATEST(
            similarity(e.razao_social, p_query),
            COALESCE(similarity(e.nome_fantasia, p_query), 0)
        ) AS similarity_score
    FROM dim_empresas e
    WHERE (
        e.razao_social ILIKE '%' || p_query || '%'
        OR e.nome_fantasia ILIKE '%' || p_query || '%'
    )
    AND (p_cidade IS NULL OR e.cidade ILIKE '%' || p_cidade || '%')
    AND (p_estado IS NULL OR e.estado = UPPER(p_estado))
    ORDER BY similarity_score DESC
    LIMIT p_limit;
\$\$;
"

run_sql "Funcao count_empresas_estimate (sem timeout)" "
CREATE OR REPLACE FUNCTION count_empresas_estimate(
    p_query TEXT DEFAULT NULL,
    p_cidade TEXT DEFAULT NULL,
    p_estado TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql STABLE
AS \$\$
DECLARE
    result BIGINT;
BEGIN
    IF p_query IS NULL AND p_cidade IS NULL AND p_estado IS NULL THEN
        SELECT reltuples::bigint INTO result FROM pg_class WHERE relname = 'dim_empresas';
        RETURN result;
    END IF;
    SELECT COUNT(*) INTO result FROM (
        SELECT 1 FROM dim_empresas
        WHERE (p_query IS NULL OR razao_social ILIKE '%' || p_query || '%'
               OR nome_fantasia ILIKE '%' || p_query || '%')
        AND (p_cidade IS NULL OR cidade ILIKE '%' || p_cidade || '%')
        AND (p_estado IS NULL OR estado = UPPER(p_estado))
        LIMIT 10000
    ) sub;
    RETURN result;
END;
\$\$;
"

run_sql "Funcao paginate_empresas (keyset, sem OFFSET)" "
CREATE OR REPLACE FUNCTION paginate_empresas(
    p_last_created_at TIMESTAMPTZ DEFAULT NULL,
    p_last_id UUID DEFAULT NULL,
    p_estado TEXT DEFAULT NULL,
    p_situacao TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    cnpj VARCHAR,
    razao_social VARCHAR,
    nome_fantasia VARCHAR,
    cidade VARCHAR,
    estado VARCHAR,
    situacao_cadastral VARCHAR,
    created_at TIMESTAMPTZ
)
LANGUAGE sql STABLE
AS \$\$
    SELECT e.id, e.cnpj, e.razao_social, e.nome_fantasia,
           e.cidade, e.estado, e.situacao_cadastral, e.created_at
    FROM dim_empresas e
    WHERE (p_last_created_at IS NULL
           OR (e.created_at, e.id) < (p_last_created_at, p_last_id))
    AND (p_estado IS NULL OR e.estado = UPPER(p_estado))
    AND (p_situacao IS NULL OR e.situacao_cadastral = p_situacao)
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT p_limit;
\$\$;
"

# ------------------------------------------
# FASE 7: TABELA fato_sis_scores
# ------------------------------------------
echo ""
echo "=========================================="
echo "[8/10] TABELA fato_sis_scores"
echo "=========================================="

run_sql "Criar fato_sis_scores" "
CREATE TABLE IF NOT EXISTS fato_sis_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES dim_empresas(id) ON DELETE CASCADE,
    text_similarity NUMERIC(4,3) DEFAULT 0,
    geo_proximity NUMERIC(4,3) DEFAULT 0,
    cnae_similarity NUMERIC(4,3) DEFAULT 0,
    political_connections NUMERIC(4,3) DEFAULT 0,
    news_volume NUMERIC(4,3) DEFAULT 0,
    relationship_density NUMERIC(4,3) DEFAULT 0,
    sis_score NUMERIC(5,2) GENERATED ALWAYS AS (
        text_similarity * 15 + geo_proximity * 10 + cnae_similarity * 15 +
        political_connections * 25 + news_volume * 15 + relationship_density * 20
    ) STORED,
    query_context TEXT,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_sis_empresa UNIQUE(empresa_id, query_context)
);
CREATE INDEX IF NOT EXISTS idx_sis_empresa ON fato_sis_scores(empresa_id);
CREATE INDEX IF NOT EXISTS idx_sis_score ON fato_sis_scores(sis_score DESC);
"

# ------------------------------------------
# FASE 8: ANALYZE
# ------------------------------------------
echo ""
echo "=========================================="
echo "[9/10] ANALYZE (atualizar estatisticas do planner)"
echo "=========================================="

run_sql "ANALYZE dim_empresas" "ANALYZE dim_empresas;"

# ------------------------------------------
# FASE 9: VALIDACAO
# ------------------------------------------
echo ""
echo "=========================================="
echo "[10/10] VALIDACAO FINAL"
echo "=========================================="

run_sql "Indexes finais" \
  "SELECT indexname, pg_size_pretty(pg_relation_size(schemaname || '.' || indexname)) AS size FROM pg_indexes WHERE tablename = 'dim_empresas' ORDER BY pg_relation_size(schemaname || '.' || indexname) DESC;"

run_sql "Tamanho total" \
  "SELECT pg_size_pretty(pg_total_relation_size('dim_empresas')) AS total, pg_size_pretty(pg_relation_size('dim_empresas')) AS table_only, pg_size_pretty(pg_total_relation_size('dim_empresas') - pg_relation_size('dim_empresas')) AS indexes;"

echo ""
echo ">>> Teste: search_empresas('petrobras')"
run_sql "Teste busca trigram" \
  "SELECT id, cnpj, razao_social, similarity_score FROM search_empresas('petrobras', NULL, NULL, 5);"

echo ""
echo ">>> Teste: count_empresas_estimate('tecnologia', NULL, 'SP')"
run_sql "Teste contagem estimada" \
  "SELECT count_empresas_estimate('tecnologia', NULL, 'SP') AS estimated_count;"

echo ""
echo "=========================================="
echo "OTIMIZACAO COMPLETA - $(date)"
echo "=========================================="
echo ""
echo "PROXIMOS PASSOS:"
echo "  1. Alterar backend para usar supabase.rpc('search_empresas', ...)"
echo "  2. Alterar estimateCardinality para usar count_empresas_estimate"
echo "  3. (Opcional) Backfill search_vector: ./scripts/backfill_search_vector.sh"
echo ""
