-- =============================================
-- Migration 022: Query Optimization Indexes
-- Data: 2026-03-03
-- Descrição: Composite and partial indexes for common query patterns
-- =============================================

-- ===========================================
-- 1. COMPOSITE INDEXES (Common Joins)
-- ===========================================

-- Geographic search by city + state
CREATE INDEX IF NOT EXISTS idx_empresas_cidade_estado ON dim_empresas(cidade, estado);

-- CNAE + city (filtered: only rows with CNAE)
CREATE INDEX IF NOT EXISTS idx_empresas_cnae_cidade ON dim_empresas(cnae_principal, cidade) WHERE cnae_principal IS NOT NULL;

-- Situação cadastral + state filter
CREATE INDEX IF NOT EXISTS idx_empresas_situacao_estado ON dim_empresas(situacao_cadastral, estado);

-- ===========================================
-- 2. PARTIAL INDEXES (Active Records)
-- ===========================================

-- Only active companies for faster searches
CREATE INDEX IF NOT EXISTS idx_empresas_ativas ON dim_empresas(id) WHERE situacao_cadastral = 'ATIVA';

-- Only active relationships for graph traversal
CREATE INDEX IF NOT EXISTS idx_relacoes_ativas ON fato_relacoes_entidades(source_type, source_id) WHERE ativo = true;

-- ===========================================
-- 3. COMPOSITE INDEXES (fato_transacao_empresas)
-- ===========================================

-- Join empresa + pessoa
CREATE INDEX IF NOT EXISTS idx_transacao_empresa_pessoa ON fato_transacao_empresas(empresa_id, pessoa_id);

-- Active transactions only
CREATE INDEX IF NOT EXISTS idx_transacao_ativo ON fato_transacao_empresas(empresa_id) WHERE ativo = true;

-- ===========================================
-- 4. COMPOSITE INDEXES (fato_regime_tributario)
-- ===========================================

-- Regime by empresa + ativo flag
CREATE INDEX IF NOT EXISTS idx_regime_empresa_ativo ON fato_regime_tributario(empresa_id, ativo);

-- CNAE in regime table (filtered)
CREATE INDEX IF NOT EXISTS idx_regime_cnae ON fato_regime_tributario(cnae_principal) WHERE cnae_principal IS NOT NULL;

-- ===========================================
-- 5. COMPOSITE INDEXES (stats_historico)
-- ===========================================

-- Category + date descending for dashboard queries
CREATE INDEX IF NOT EXISTS idx_stats_hist_cat_data ON stats_historico(categoria, data DESC);

-- ===========================================
-- 6. OPTIMIZE dim_noticias
-- ===========================================

-- News by empresa (filtered: only linked)
CREATE INDEX IF NOT EXISTS idx_noticias_empresa ON dim_noticias(empresa_id) WHERE empresa_id IS NOT NULL;

-- News by publication date descending
CREATE INDEX IF NOT EXISTS idx_noticias_data ON dim_noticias(data_publicacao DESC);

-- ===========================================
-- COMMENTS
-- ===========================================

COMMENT ON INDEX idx_empresas_cidade_estado IS 'Composite: geographic search by city+state';
COMMENT ON INDEX idx_empresas_cnae_cidade IS 'Partial composite: CNAE + city for sector-geographic queries';
COMMENT ON INDEX idx_empresas_situacao_estado IS 'Composite: filter by cadastral status + state';
COMMENT ON INDEX idx_empresas_ativas IS 'Partial: only active companies for faster searches';
COMMENT ON INDEX idx_relacoes_ativas IS 'Partial: only active relationships for graph traversal';
COMMENT ON INDEX idx_transacao_empresa_pessoa IS 'Composite: fast join empresa-pessoa in transactions';
COMMENT ON INDEX idx_transacao_ativo IS 'Partial: only active transactions per empresa';
COMMENT ON INDEX idx_regime_empresa_ativo IS 'Composite: regime lookup by empresa + active flag';
COMMENT ON INDEX idx_regime_cnae IS 'Partial: CNAE lookup in regime table (non-null only)';
COMMENT ON INDEX idx_stats_hist_cat_data IS 'Composite: dashboard stats by category + date DESC';
COMMENT ON INDEX idx_noticias_empresa IS 'Partial: news linked to specific empresa';
COMMENT ON INDEX idx_noticias_data IS 'Index: news ordered by publication date DESC';
