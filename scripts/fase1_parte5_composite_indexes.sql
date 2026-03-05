-- =============================================
-- FASE 1 - PARTE 5/5: Composite & Partial Indexes
-- Executar no Supabase SQL Editor
-- Tempo estimado: 10-30s
-- =============================================

-- dim_empresas
CREATE INDEX IF NOT EXISTS idx_empresas_cidade_estado ON dim_empresas(cidade, estado);
CREATE INDEX IF NOT EXISTS idx_empresas_cnae_cidade ON dim_empresas(cnae_principal, cidade) WHERE cnae_principal IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_empresas_situacao_estado ON dim_empresas(situacao_cadastral, estado);
CREATE INDEX IF NOT EXISTS idx_empresas_ativas ON dim_empresas(id) WHERE situacao_cadastral = 'ATIVA';

-- fato_relacoes_entidades
CREATE INDEX IF NOT EXISTS idx_relacoes_ativas ON fato_relacoes_entidades(source_type, source_id) WHERE ativo = true;

-- fato_transacao_empresas
CREATE INDEX IF NOT EXISTS idx_transacao_empresa_pessoa ON fato_transacao_empresas(empresa_id, pessoa_id);
CREATE INDEX IF NOT EXISTS idx_transacao_ativo ON fato_transacao_empresas(empresa_id) WHERE ativo = true;

-- fato_regime_tributario
CREATE INDEX IF NOT EXISTS idx_regime_empresa_ativo ON fato_regime_tributario(empresa_id, ativo);
CREATE INDEX IF NOT EXISTS idx_regime_cnae ON fato_regime_tributario(cnae_principal) WHERE cnae_principal IS NOT NULL;

-- stats_historico
CREATE INDEX IF NOT EXISTS idx_stats_hist_cat_data ON stats_historico(categoria, data DESC);

-- dim_noticias
CREATE INDEX IF NOT EXISTS idx_noticias_empresa ON dim_noticias(empresa_id) WHERE empresa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_noticias_data ON dim_noticias(data_publicacao DESC);

-- COMMENTS
COMMENT ON INDEX idx_empresas_cidade_estado IS 'Composite: geographic search by city+state';
COMMENT ON INDEX idx_empresas_ativas IS 'Partial: only active companies for faster searches';
COMMENT ON INDEX idx_regime_empresa_ativo IS 'Composite: regime lookup by empresa + active flag';
COMMENT ON INDEX idx_stats_hist_cat_data IS 'Composite: dashboard stats by category + date DESC';

-- VERIFICACAO FINAL
SELECT 'FASE 1 COMPLETA' AS status,
       (SELECT COUNT(*) FROM pg_indexes WHERE indexname LIKE 'idx_%_trgm') AS trigram_indexes,
       (SELECT COUNT(*) FROM pg_indexes WHERE indexname LIKE 'idx_sis_%') AS sis_indexes,
       (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'dim_empresas' AND column_name = 'search_vector') AS has_search_vector,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'fato_sis_scores') AS has_sis_table,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'fato_relacoes_entidades') AS has_graph_table;
