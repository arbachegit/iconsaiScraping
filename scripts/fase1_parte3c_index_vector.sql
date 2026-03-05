-- =============================================
-- FASE 1 - PARTE 3c/5: Criar GIN index no search_vector
-- Executar SOMENTE quando parte 3b mostrar pending = 0
-- Tempo estimado: 10-60s
-- =============================================

CREATE INDEX IF NOT EXISTS idx_empresas_search_vector ON dim_empresas USING gin(search_vector);

SELECT 'PARTE 3c OK - GIN index criado' AS status,
       (SELECT COUNT(*) FROM dim_empresas WHERE search_vector IS NOT NULL) AS rows_with_vector;
