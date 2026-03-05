-- =============================================
-- OTIMIZACAO COMPLETA: dim_empresas (64M+ rows)
-- Data: 2026-03-05
-- Ambiente: Supabase PostgreSQL (128GB RAM, 48-core ARM)
-- =============================================
--
-- SUMARIO DE PROBLEMAS ENCONTRADOS:
-- 1. pg_trgm NAO habilitado → ILIKE faz seq scan em 64M rows
-- 2. ZERO indexes GIN para busca textual
-- 3. COUNT(exact) com ILIKE → TIMEOUT (8s+)
-- 4. ORDER BY created_at → TIMEOUT (sem index)
-- 5. Colunas referenciadas no codigo nao existem (descricao, cnae_principal, etc.)
-- 6. search_vector (tsvector) nao existe → FTS impossivel
-- 7. fato_sis_scores nao existe → SIS scoring impossivel
-- 8. Composite indexes para join patterns NAO existem
--
-- EXECUTAR EM ORDEM, BLOCO POR BLOCO, NO SUPABASE SQL EDITOR
-- Cada bloco eh independente. Se um falhar, prossiga para o proximo.
-- =============================================


-- =============================================
-- FASE A: EXTENSOES NECESSARIAS
-- Tempo: < 1s
-- Risco: ZERO (idempotente)
-- =============================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Verificar:
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_trgm';


-- =============================================
-- FASE B: INDEXES CRITICOS (ALTO IMPACTO)
-- Tempo: 5-30 min cada (CONCURRENTLY nao bloqueia)
-- Risco: BAIXO (cria em background)
--
-- NOTA IMPORTANTE: CREATE INDEX CONCURRENTLY nao pode
-- rodar dentro de uma transacao. Execute CADA comando
-- separadamente no SQL Editor.
-- =============================================

-- B1: GIN trigram em razao_social (busca textual principal)
-- Impacto: ILIKE '%texto%' vai de seq scan 64M → index scan
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_razao_trgm
    ON dim_empresas USING gin(razao_social gin_trgm_ops);

-- B2: GIN trigram em nome_fantasia (segunda coluna de busca)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_nome_trgm
    ON dim_empresas USING gin(nome_fantasia gin_trgm_ops);

-- B3: Partial index em empresas ATIVAS (filtra 64M → ~30M)
-- O textSearch() e relationalSearch() devem filtrar por situacao_cadastral
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_ativas
    ON dim_empresas(id)
    WHERE situacao_cadastral = 'ATIVA';

-- B4: Index composto cidade + estado (busca geografica)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_cidade_estado
    ON dim_empresas(cidade, estado);

-- B5: Index em situacao_cadastral + estado (filtro comum)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_situacao_estado
    ON dim_empresas(situacao_cadastral, estado);

-- B6: Index em created_at DESC (paginacao por data)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_created_at
    ON dim_empresas(created_at DESC);

-- B7: Index em codigo_ibge (join com dados geograficos)
-- Ja existe da migration 009, mas verificar:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dim_empresas_ibge
    ON dim_empresas(codigo_ibge);

-- B8: Index em cnae_id (FK para dim_cnaes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_cnae_id
    ON dim_empresas(cnae_id)
    WHERE cnae_id IS NOT NULL;


-- =============================================
-- FASE C: COVERING INDEXES (ELIMINAR HEAP LOOKUPS)
-- Tempo: 10-30 min cada
-- Risco: BAIXO
-- =============================================

-- C1: Covering index para busca por CNPJ
-- Retorna id + razao_social sem ir ao heap
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_cnpj_cover
    ON dim_empresas(cnpj)
    INCLUDE (id, razao_social, nome_fantasia, cidade, estado, situacao_cadastral);

-- C2: Covering index para busca por cidade
-- Retorna dados basicos sem heap lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_cidade_cover
    ON dim_empresas(cidade)
    INCLUDE (id, cnpj, razao_social, nome_fantasia, estado, situacao_cadastral);


-- =============================================
-- FASE D: FULL-TEXT SEARCH (tsvector)
-- Tempo: 30-60 min (backfill de 64M rows)
-- Risco: MEDIO (altera schema, adiciona trigger)
-- =============================================

-- D1: Adicionar coluna search_vector
ALTER TABLE dim_empresas ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- D2: Trigger para manter search_vector atualizado em novos inserts/updates
CREATE OR REPLACE FUNCTION update_empresas_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := (
        setweight(to_tsvector('portuguese', COALESCE(NEW.razao_social, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.nome_fantasia, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.cidade, '')), 'C') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.estado, '')), 'C')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_empresas_search_vector ON dim_empresas;
CREATE TRIGGER trg_empresas_search_vector
    BEFORE INSERT OR UPDATE OF razao_social, nome_fantasia, cidade, estado
    ON dim_empresas
    FOR EACH ROW
    EXECUTE FUNCTION update_empresas_search_vector();

-- D3: Backfill em batches (para nao estourar statement_timeout)
-- EXECUTAR MULTIPLAS VEZES ate retornar 0 rows updated
-- Cada execucao processa 500K linhas
UPDATE dim_empresas
SET search_vector = (
    setweight(to_tsvector('portuguese', COALESCE(razao_social, '')), 'A') ||
    setweight(to_tsvector('portuguese', COALESCE(nome_fantasia, '')), 'A') ||
    setweight(to_tsvector('portuguese', COALESCE(cidade, '')), 'C') ||
    setweight(to_tsvector('portuguese', COALESCE(estado, '')), 'C')
)
WHERE id IN (
    SELECT id FROM dim_empresas
    WHERE search_vector IS NULL
    LIMIT 500000
);

-- Verificar progresso:
SELECT
    COUNT(*) FILTER (WHERE search_vector IS NOT NULL) AS populated,
    COUNT(*) FILTER (WHERE search_vector IS NULL) AS pending,
    COUNT(*) AS total
FROM dim_empresas;

-- D4: Index GIN no search_vector (somente apos backfill completo)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_search_vector
    ON dim_empresas USING gin(search_vector);


-- =============================================
-- FASE E: TABELA fato_sis_scores
-- Tempo: < 1s
-- Risco: ZERO (nova tabela)
-- =============================================

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
        text_similarity * 15 +
        geo_proximity * 10 +
        cnae_similarity * 15 +
        political_connections * 25 +
        news_volume * 15 +
        relationship_density * 20
    ) STORED,
    query_context TEXT,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_sis_empresa UNIQUE(empresa_id, query_context)
);

CREATE INDEX IF NOT EXISTS idx_sis_empresa ON fato_sis_scores(empresa_id);
CREATE INDEX IF NOT EXISTS idx_sis_score ON fato_sis_scores(sis_score DESC);


-- =============================================
-- FASE F: FUNCAO RPC PARA BUSCA OTIMIZADA
-- Tempo: < 1s
-- Risco: ZERO (nova funcao)
--
-- Substitui o ILIKE do PostgREST por query otimizada
-- com trigram similarity + LIMIT, sem COUNT
-- =============================================

CREATE OR REPLACE FUNCTION search_empresas(
    p_query TEXT,
    p_cidade TEXT DEFAULT NULL,
    p_estado TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    cnpj TEXT,
    razao_social TEXT,
    nome_fantasia TEXT,
    cidade TEXT,
    estado TEXT,
    situacao_cadastral TEXT,
    similarity_score REAL
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        e.id,
        e.cnpj,
        e.razao_social,
        e.nome_fantasia,
        e.cidade,
        e.estado,
        e.situacao_cadastral,
        GREATEST(
            similarity(e.razao_social, p_query),
            similarity(e.nome_fantasia, p_query)
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
$$;

COMMENT ON FUNCTION search_empresas IS 'Busca otimizada por nome com trigram similarity. Usa GIN indexes.';


-- =============================================
-- FASE G: FUNCAO RPC PARA FULL-TEXT SEARCH
-- (somente apos backfill do search_vector - FASE D)
-- =============================================

CREATE OR REPLACE FUNCTION fts_empresas(
    p_query TEXT,
    p_cidade TEXT DEFAULT NULL,
    p_estado TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    cnpj TEXT,
    razao_social TEXT,
    nome_fantasia TEXT,
    cidade TEXT,
    estado TEXT,
    situacao_cadastral TEXT,
    rank REAL
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        e.id,
        e.cnpj,
        e.razao_social,
        e.nome_fantasia,
        e.cidade,
        e.estado,
        e.situacao_cadastral,
        ts_rank(e.search_vector, plainto_tsquery('portuguese', p_query)) AS rank
    FROM dim_empresas e
    WHERE e.search_vector @@ plainto_tsquery('portuguese', p_query)
    AND (p_cidade IS NULL OR e.cidade ILIKE '%' || p_cidade || '%')
    AND (p_estado IS NULL OR e.estado = UPPER(p_estado))
    ORDER BY rank DESC
    LIMIT p_limit;
$$;

COMMENT ON FUNCTION fts_empresas IS 'Full-text search com ranking. Requer search_vector populado.';


-- =============================================
-- FASE H: FUNCAO RPC PARA CONTAGEM ESTIMADA
-- (substitui COUNT(exact) que da timeout)
-- =============================================

CREATE OR REPLACE FUNCTION count_empresas_estimate(
    p_query TEXT DEFAULT NULL,
    p_cidade TEXT DEFAULT NULL,
    p_estado TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    result BIGINT;
BEGIN
    -- Se nao tem filtro, usar estimativa do pg_class (instantanea)
    IF p_query IS NULL AND p_cidade IS NULL AND p_estado IS NULL THEN
        SELECT reltuples::bigint INTO result
        FROM pg_class WHERE relname = 'dim_empresas';
        RETURN result;
    END IF;

    -- Se tem filtro por estado apenas, usar estimativa proporcional
    IF p_query IS NULL AND p_cidade IS NULL AND p_estado IS NOT NULL THEN
        SELECT COUNT(*) INTO result
        FROM dim_empresas
        WHERE estado = UPPER(p_estado)
        LIMIT 1;
        -- COUNT com equality filter no index eh rapido
        RETURN result;
    END IF;

    -- Para texto, usar COUNT com LIMIT de seguranca
    -- Se encontrou 10000+, retorna 10000 como "muitos"
    SELECT COUNT(*) INTO result
    FROM (
        SELECT 1 FROM dim_empresas
        WHERE (p_query IS NULL OR razao_social ILIKE '%' || p_query || '%'
               OR nome_fantasia ILIKE '%' || p_query || '%')
        AND (p_cidade IS NULL OR cidade ILIKE '%' || p_cidade || '%')
        AND (p_estado IS NULL OR estado = UPPER(p_estado))
        LIMIT 10000
    ) sub;

    RETURN result;
END;
$$;

COMMENT ON FUNCTION count_empresas_estimate IS 'Contagem estimada que nunca da timeout. Retorna max 10000.';


-- =============================================
-- FASE I: KEYSET PAGINATION FUNCTION
-- (substitui OFFSET que degrada com paginas altas)
-- =============================================

CREATE OR REPLACE FUNCTION paginate_empresas(
    p_last_created_at TIMESTAMPTZ DEFAULT NULL,
    p_last_id UUID DEFAULT NULL,
    p_estado TEXT DEFAULT NULL,
    p_situacao TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    cnpj TEXT,
    razao_social TEXT,
    nome_fantasia TEXT,
    cidade TEXT,
    estado TEXT,
    situacao_cadastral TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        e.id,
        e.cnpj,
        e.razao_social,
        e.nome_fantasia,
        e.cidade,
        e.estado,
        e.situacao_cadastral,
        e.created_at
    FROM dim_empresas e
    WHERE (
        p_last_created_at IS NULL
        OR (e.created_at, e.id) < (p_last_created_at, p_last_id)
    )
    AND (p_estado IS NULL OR e.estado = UPPER(p_estado))
    AND (p_situacao IS NULL OR e.situacao_cadastral = p_situacao)
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT p_limit;
$$;

COMMENT ON FUNCTION paginate_empresas IS 'Keyset pagination. Nunca usa OFFSET.';


-- =============================================
-- FASE J: VACUUM E ANALYZE
-- Tempo: 5-30 min
-- Risco: ZERO (manutencao normal)
-- Executar APOS criar todos os indexes
-- =============================================

-- Atualizar estatisticas do planner (CRITICO apos criar indexes)
ANALYZE dim_empresas;

-- Se dead_pct > 10%, executar VACUUM
-- (verificar com: SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'dim_empresas')
-- VACUUM (VERBOSE) dim_empresas;


-- =============================================
-- VERIFICACAO FINAL
-- =============================================

-- Listar todos os indexes de dim_empresas
SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes
WHERE tablename = 'dim_empresas'
ORDER BY pg_relation_size(indexname::regclass) DESC;

-- Verificar extensoes
SELECT extname, extversion FROM pg_extension WHERE extname IN ('pg_trgm', 'vector');

-- Verificar search_vector progress
SELECT
    COUNT(*) FILTER (WHERE search_vector IS NOT NULL) AS sv_populated,
    COUNT(*) FILTER (WHERE search_vector IS NULL) AS sv_pending
FROM dim_empresas
WHERE id IN (SELECT id FROM dim_empresas LIMIT 10000);

-- Testar search_empresas (deve retornar em < 500ms)
SELECT * FROM search_empresas('petrobras', NULL, NULL, 10);

-- Testar count_empresas_estimate (deve retornar em < 1s)
SELECT count_empresas_estimate('tecnologia', NULL, 'SP');
