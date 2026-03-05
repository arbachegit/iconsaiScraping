-- =============================================
-- FASE 1 - PARTE 2/5: Trigram Indexes (GIN)
-- Executar no Supabase SQL Editor
-- Tempo estimado: 10-30s (depende do volume)
-- =============================================

CREATE INDEX IF NOT EXISTS idx_empresas_nome_trgm ON dim_empresas USING gin(nome_fantasia gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_empresas_razao_trgm ON dim_empresas USING gin(razao_social gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_pessoas_nome_trgm ON dim_pessoas USING gin(nome_completo gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_noticias_titulo_trgm ON dim_noticias USING gin(titulo gin_trgm_ops);

SELECT 'PARTE 2/5 OK' AS status,
       (SELECT COUNT(*) FROM pg_indexes WHERE indexname LIKE 'idx_%_trgm') AS trigram_indexes;
