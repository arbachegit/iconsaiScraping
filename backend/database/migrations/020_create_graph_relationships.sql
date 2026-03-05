-- =============================================
-- Migration 020: Graph Relationships (Entity Graph)
-- Data: 2026-03-03
-- Descrição: Tabela polimórfica para grafo de relacionamentos entre entidades
-- =============================================

-- Enable trigram extension for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ===========================================
-- FATO: RELAÇÕES ENTRE ENTIDADES (Grafo)
-- ===========================================

CREATE TABLE IF NOT EXISTS fato_relacoes_entidades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Source node
    source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('empresa','pessoa','politico','emenda','noticia')),
    source_id TEXT NOT NULL,

    -- Target node
    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('empresa','pessoa','politico','emenda','noticia')),
    target_id TEXT NOT NULL,

    -- Relationship
    tipo_relacao VARCHAR(30) NOT NULL CHECK (tipo_relacao IN (
        'societaria','fornecedor','concorrente','parceiro','regulador',
        'beneficiario','mencionado_em','cnae_similar','geografico','politico_empresarial'
    )),

    -- Scores
    strength NUMERIC(3,2) DEFAULT 0.5 CHECK (strength BETWEEN 0 AND 1),
    confidence NUMERIC(3,2) DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),

    -- Attributes
    bidirecional BOOLEAN DEFAULT false,
    source VARCHAR(50) DEFAULT 'system',
    detection_method VARCHAR(50),
    metadata JSONB DEFAULT '{}',
    descricao TEXT,

    -- Temporal
    data_inicio DATE,
    data_fim DATE,
    ativo BOOLEAN DEFAULT true,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Prevent duplicate edges
    CONSTRAINT uk_relacao_unica UNIQUE(source_type, source_id, target_type, target_id, tipo_relacao)
);

-- ===========================================
-- INDEXES for graph traversal
-- ===========================================

-- Source lookup (outgoing edges)
CREATE INDEX IF NOT EXISTS idx_rel_source ON fato_relacoes_entidades(source_type, source_id);

-- Target lookup (incoming edges)
CREATE INDEX IF NOT EXISTS idx_rel_target ON fato_relacoes_entidades(target_type, target_id);

-- Relationship type filter
CREATE INDEX IF NOT EXISTS idx_rel_tipo ON fato_relacoes_entidades(tipo_relacao);

-- Strength ranking
CREATE INDEX IF NOT EXISTS idx_rel_strength ON fato_relacoes_entidades(strength DESC);

-- Active-only partial index
CREATE INDEX IF NOT EXISTS idx_rel_ativo ON fato_relacoes_entidades(ativo) WHERE ativo = true;

-- JSONB metadata search
CREATE INDEX IF NOT EXISTS idx_rel_metadata ON fato_relacoes_entidades USING gin(metadata);

-- Composite for common traversal pattern
CREATE INDEX IF NOT EXISTS idx_rel_source_ativo ON fato_relacoes_entidades(source_type, source_id, ativo) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS idx_rel_target_ativo ON fato_relacoes_entidades(target_type, target_id, ativo) WHERE ativo = true;

-- ===========================================
-- TRIGGER: updated_at auto-update
-- ===========================================

CREATE OR REPLACE FUNCTION update_relacoes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_relacoes_updated_at ON fato_relacoes_entidades;
CREATE TRIGGER trg_relacoes_updated_at
    BEFORE UPDATE ON fato_relacoes_entidades
    FOR EACH ROW
    EXECUTE FUNCTION update_relacoes_updated_at();

-- ===========================================
-- COMMENTS
-- ===========================================

COMMENT ON TABLE fato_relacoes_entidades IS 'Grafo polimórfico de relacionamentos entre entidades (empresa, pessoa, político, emenda, notícia)';
COMMENT ON COLUMN fato_relacoes_entidades.source_type IS 'Tipo da entidade origem (empresa, pessoa, politico, emenda, noticia)';
COMMENT ON COLUMN fato_relacoes_entidades.target_type IS 'Tipo da entidade destino (empresa, pessoa, politico, emenda, noticia)';
COMMENT ON COLUMN fato_relacoes_entidades.tipo_relacao IS 'Tipo do relacionamento (societaria, fornecedor, concorrente, parceiro, etc)';
COMMENT ON COLUMN fato_relacoes_entidades.strength IS 'Força do relacionamento (0-1). CEO=1.0, sócio=0.8, colaborador=0.4';
COMMENT ON COLUMN fato_relacoes_entidades.confidence IS 'Confiança na detecção (0-1). Manual=1.0, automático=0.5-0.8';
COMMENT ON COLUMN fato_relacoes_entidades.detection_method IS 'Método de detecção: socios_qsa, cnae_match, geo_match, news_mention, manual';

-- ===========================================
-- Register data source (compliance)
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
) VALUES (
    'Graph Engine - Relações de Entidades',
    'inteligencia',
    'IconsAI Internal',
    'internal://graph-engine',
    'alta',
    false,
    'tempo_real',
    'JSON',
    'Motor de grafo interno que detecta relacionamentos entre empresas, pessoas, políticos, emendas e notícias'
)
ON CONFLICT (nome) DO NOTHING;
