-- =============================================
-- FASE 1 - PARTE 4/5: SIS Scores Table
-- Executar no Supabase SQL Editor
-- Tempo estimado: < 5s
-- =============================================

CREATE TABLE IF NOT EXISTS fato_sis_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    empresa_id INTEGER NOT NULL REFERENCES dim_empresas(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_sis_calculated ON fato_sis_scores(calculated_at DESC);

COMMENT ON TABLE fato_sis_scores IS 'Strategic Impact Score (SIS) - Pontuacao de impacto estrategico por empresa';

INSERT INTO fontes_dados (nome, categoria, fonte_primaria, url, confiabilidade, api_key_necessaria, periodicidade, formato, observacoes)
VALUES
('Hybrid Search Engine', 'inteligencia', 'IconsAI Internal', 'internal://hybrid-search', 'alta', false, 'tempo_real', 'JSON', 'Motor de busca hibrida: trigram + full-text + vector + relational com RRF ranking'),
('OpenAI Embeddings - text-embedding-3-small', 'ia', 'OpenAI', 'https://api.openai.com/v1/embeddings', 'alta', true, 'sob_demanda', 'JSON', 'Embeddings semanticos para busca vetorial (1536 dimensoes)')
ON CONFLICT (nome) DO NOTHING;

SELECT 'PARTE 4/5 OK' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'fato_sis_scores') AS has_sis_table;
