-- =============================================
-- FASE 1 - PARTE 3b/5: Backfill search_vector
-- EXECUTAR MULTIPLAS VEZES ate retornar 0 updated
-- Cada execucao processa ~50k linhas (50 batches x 1000)
-- Tempo estimado: ~30s por execucao
-- =============================================

DO $$
DECLARE
    batch_size INT := 1000;
    max_batches INT := 50;
    total_updated INT := 0;
    rows_affected INT;
    i INT := 0;
BEGIN
    LOOP
        UPDATE dim_empresas SET search_vector = (
            setweight(to_tsvector('portuguese', COALESCE(razao_social, '')), 'A') ||
            setweight(to_tsvector('portuguese', COALESCE(nome_fantasia, '')), 'A') ||
            setweight(to_tsvector('portuguese', COALESCE(cidade, '')), 'B') ||
            setweight(to_tsvector('portuguese', COALESCE(estado, '')), 'C')
        )
        WHERE id IN (
            SELECT id FROM dim_empresas
            WHERE search_vector IS NULL
            LIMIT batch_size
        );

        GET DIAGNOSTICS rows_affected = ROW_COUNT;
        total_updated := total_updated + rows_affected;
        i := i + 1;

        EXIT WHEN rows_affected = 0 OR i >= max_batches;
    END LOOP;

    RAISE NOTICE 'Updated % rows in % batches', total_updated, i;
END $$;

-- Verificar progresso
SELECT
    COUNT(*) FILTER (WHERE search_vector IS NOT NULL) AS done,
    COUNT(*) FILTER (WHERE search_vector IS NULL) AS pending,
    COUNT(*) AS total,
    ROUND(100.0 * COUNT(*) FILTER (WHERE search_vector IS NOT NULL) / GREATEST(COUNT(*), 1), 2) AS pct
FROM dim_empresas;
