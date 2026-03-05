-- =============================================
-- FASE 1 - PARTE 1/5: pg_trgm + Tabela Graph
-- Executar no Supabase SQL Editor
-- Tempo estimado: < 5s
-- =============================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- FATO: RELACOES ENTRE ENTIDADES (Grafo)
CREATE TABLE IF NOT EXISTS fato_relacoes_entidades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('empresa','pessoa','politico','emenda','noticia')),
    source_id TEXT NOT NULL,
    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('empresa','pessoa','politico','emenda','noticia')),
    target_id TEXT NOT NULL,
    tipo_relacao VARCHAR(30) NOT NULL CHECK (tipo_relacao IN (
        'societaria','fornecedor','concorrente','parceiro','regulador',
        'beneficiario','mencionado_em','cnae_similar','geografico','politico_empresarial'
    )),
    strength NUMERIC(3,2) DEFAULT 0.5 CHECK (strength BETWEEN 0 AND 1),
    confidence NUMERIC(3,2) DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    bidirecional BOOLEAN DEFAULT false,
    source VARCHAR(50) DEFAULT 'system',
    detection_method VARCHAR(50),
    metadata JSONB DEFAULT '{}',
    descricao TEXT,
    data_inicio DATE,
    data_fim DATE,
    ativo BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_relacao_unica UNIQUE(source_type, source_id, target_type, target_id, tipo_relacao)
);

CREATE INDEX IF NOT EXISTS idx_rel_source ON fato_relacoes_entidades(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON fato_relacoes_entidades(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_rel_tipo ON fato_relacoes_entidades(tipo_relacao);
CREATE INDEX IF NOT EXISTS idx_rel_strength ON fato_relacoes_entidades(strength DESC);
CREATE INDEX IF NOT EXISTS idx_rel_ativo ON fato_relacoes_entidades(ativo) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS idx_rel_metadata ON fato_relacoes_entidades USING gin(metadata);
CREATE INDEX IF NOT EXISTS idx_rel_source_ativo ON fato_relacoes_entidades(source_type, source_id, ativo) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS idx_rel_target_ativo ON fato_relacoes_entidades(target_type, target_id, ativo) WHERE ativo = true;

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

COMMENT ON TABLE fato_relacoes_entidades IS 'Grafo polimorfico de relacionamentos entre entidades';

INSERT INTO fontes_dados (nome, categoria, fonte_primaria, url, confiabilidade, api_key_necessaria, periodicidade, formato, observacoes)
VALUES ('Graph Engine - Relacoes de Entidades', 'inteligencia', 'IconsAI Internal', 'internal://graph-engine', 'alta', false, 'tempo_real', 'JSON', 'Motor de grafo interno que detecta relacionamentos entre empresas, pessoas, politicos, emendas e noticias')
ON CONFLICT (nome) DO NOTHING;

SELECT 'PARTE 1/5 OK' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'fato_relacoes_entidades') AS graph_table;
