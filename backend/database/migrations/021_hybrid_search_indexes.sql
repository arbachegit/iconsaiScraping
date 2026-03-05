-- =============================================
-- Migration 021: Hybrid Search Indexes
-- Data: 2026-03-03
-- Descrição: Trigram, full-text search, pgvector, SIS scores
-- NOTA: pgvector must be enabled manually in Supabase Dashboard
--       (Database -> Extensions -> Enable "vector")
-- =============================================

-- ===========================================
-- 1. TRIGRAM INDEXES (pg_trgm)
-- ===========================================

-- pg_trgm already enabled by migration 020

-- Empresa text search indexes
CREATE INDEX IF NOT EXISTS idx_empresas_nome_trgm
    ON dim_empresas USING gin(nome_fantasia gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_empresas_razao_trgm
    ON dim_empresas USING gin(razao_social gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_empresas_descricao_trgm
    ON dim_empresas USING gin(descricao gin_trgm_ops);

-- Pessoa text search indexes
CREATE INDEX IF NOT EXISTS idx_pessoas_nome_trgm
    ON dim_pessoas USING gin(nome_completo gin_trgm_ops);

-- Noticia text search indexes
CREATE INDEX IF NOT EXISTS idx_noticias_titulo_trgm
    ON dim_noticias USING gin(titulo gin_trgm_ops);

-- ===========================================
-- 2. FULL-TEXT SEARCH (tsvector)
-- ===========================================

-- Add search vector column
ALTER TABLE dim_empresas ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Populate existing rows
UPDATE dim_empresas SET search_vector = (
    setweight(to_tsvector('portuguese', COALESCE(razao_social, '')), 'A') ||
    setweight(to_tsvector('portuguese', COALESCE(nome_fantasia, '')), 'A') ||
    setweight(to_tsvector('portuguese', COALESCE(descricao, '')), 'B') ||
    setweight(to_tsvector('portuguese', COALESCE(cidade, '')), 'C') ||
    setweight(to_tsvector('portuguese', COALESCE(estado, '')), 'C')
)
WHERE search_vector IS NULL;

-- GIN index on search_vector
CREATE INDEX IF NOT EXISTS idx_empresas_search_vector
    ON dim_empresas USING gin(search_vector);

-- Auto-update trigger
CREATE OR REPLACE FUNCTION update_empresas_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := (
        setweight(to_tsvector('portuguese', COALESCE(NEW.razao_social, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.nome_fantasia, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.descricao, '')), 'B') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.cidade, '')), 'C') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.estado, '')), 'C')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_empresas_search_vector ON dim_empresas;
CREATE TRIGGER trg_empresas_search_vector
    BEFORE INSERT OR UPDATE OF razao_social, nome_fantasia, descricao, cidade, estado
    ON dim_empresas
    FOR EACH ROW
    EXECUTE FUNCTION update_empresas_search_vector();

-- ===========================================
-- 3. PGVECTOR (Semantic Search)
-- ===========================================

-- NOTE: Run this ONLY after enabling pgvector in Supabase Dashboard
-- CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding column (text-embedding-3-small = 1536 dimensions)
-- Safe: ALTER TABLE ADD COLUMN IF NOT EXISTS won't fail if vector ext is missing,
-- it will just fail. Run generate_embeddings.py after enabling extension.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        EXECUTE 'ALTER TABLE dim_empresas ADD COLUMN IF NOT EXISTS embedding vector(1536)';
    ELSE
        RAISE NOTICE 'pgvector extension not enabled. Skipping embedding column. Enable it in Supabase Dashboard.';
    END IF;
END
$$;

-- HNSW index (create after embeddings are populated)
-- Run manually after generate_embeddings.py:
-- CREATE INDEX idx_empresas_embedding ON dim_empresas USING hnsw(embedding vector_cosine_ops);

-- ===========================================
-- 4. STRATEGIC IMPACT SCORE (SIS)
-- ===========================================

CREATE TABLE IF NOT EXISTS fato_sis_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    empresa_id INTEGER NOT NULL REFERENCES dim_empresas(id) ON DELETE CASCADE,

    -- Component scores (0-1)
    text_similarity NUMERIC(4,3) DEFAULT 0,
    geo_proximity NUMERIC(4,3) DEFAULT 0,
    cnae_similarity NUMERIC(4,3) DEFAULT 0,
    political_connections NUMERIC(4,3) DEFAULT 0,
    news_volume NUMERIC(4,3) DEFAULT 0,
    relationship_density NUMERIC(4,3) DEFAULT 0,

    -- Composite score (0-100)
    sis_score NUMERIC(5,2) GENERATED ALWAYS AS (
        text_similarity * 15 +
        geo_proximity * 10 +
        cnae_similarity * 15 +
        political_connections * 25 +
        news_volume * 15 +
        relationship_density * 20
    ) STORED,

    -- Context
    query_context TEXT,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uk_sis_empresa UNIQUE(empresa_id, query_context)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sis_empresa ON fato_sis_scores(empresa_id);
CREATE INDEX IF NOT EXISTS idx_sis_score ON fato_sis_scores(sis_score DESC);
CREATE INDEX IF NOT EXISTS idx_sis_calculated ON fato_sis_scores(calculated_at DESC);

-- ===========================================
-- COMMENTS
-- ===========================================

COMMENT ON TABLE fato_sis_scores IS 'Strategic Impact Score (SIS) - Pontuação de impacto estratégico por empresa';
COMMENT ON COLUMN fato_sis_scores.sis_score IS 'Score composto 0-100: text(15) + geo(10) + cnae(15) + political(25) + news(15) + relationships(20)';
COMMENT ON COLUMN dim_empresas.search_vector IS 'Full-text search vector (Portuguese) for fast text queries';

-- ===========================================
-- Register data sources (compliance)
-- ===========================================

INSERT INTO fontes_dados (
    nome,
    categoria,
    fonte_primaria,
    url,
    confiabilidade,
    api_key_necessaria,
    periodicidade,
    formato,
    observacoes
) VALUES
(
    'Hybrid Search Engine',
    'inteligencia',
    'IconsAI Internal',
    'internal://hybrid-search',
    'alta',
    false,
    'tempo_real',
    'JSON',
    'Motor de busca híbrida: trigram + full-text + vector + relational com RRF ranking'
),
(
    'OpenAI Embeddings - text-embedding-3-small',
    'ia',
    'OpenAI',
    'https://api.openai.com/v1/embeddings',
    'alta',
    true,
    'sob_demanda',
    'JSON',
    'Embeddings semânticos para busca vetorial (1536 dimensões)'
)
ON CONFLICT (nome) DO NOTHING;
