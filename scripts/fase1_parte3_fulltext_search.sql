-- =============================================
-- FASE 1 - PARTE 3/5: Full-Text Search (tsvector)
-- Executar no Supabase SQL Editor
-- NOTA: UPDATE em batch de 5000 para evitar timeout
-- Tempo estimado: 10-60s (depende do volume)
-- =============================================

-- 1. Adicionar coluna search_vector
ALTER TABLE dim_empresas ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 2. Popular em batches de 5000 linhas
DO $$
DECLARE
    batch_size INT := 5000;
    total_updated INT := 0;
    rows_affected INT;
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

        RAISE NOTICE 'Batch: % rows updated (total: %)', rows_affected, total_updated;

        EXIT WHEN rows_affected = 0;
    END LOOP;

    RAISE NOTICE 'DONE: % total rows updated', total_updated;
END $$;

-- 3. Criar index GIN no search_vector
CREATE INDEX IF NOT EXISTS idx_empresas_search_vector ON dim_empresas USING gin(search_vector);

-- 4. Trigger para auto-update
CREATE OR REPLACE FUNCTION update_empresas_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := (
        setweight(to_tsvector('portuguese', COALESCE(NEW.razao_social, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.nome_fantasia, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.cidade, '')), 'B') ||
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

-- 5. pgvector (condicional)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        EXECUTE 'ALTER TABLE dim_empresas ADD COLUMN IF NOT EXISTS embedding vector(1536)';
    ELSE
        RAISE NOTICE 'pgvector not enabled. Skipping embedding column.';
    END IF;
END $$;

COMMENT ON COLUMN dim_empresas.search_vector IS 'Full-text search vector (Portuguese) for fast text queries';

SELECT 'PARTE 3/5 OK' AS status,
       (SELECT COUNT(*) FROM dim_empresas WHERE search_vector IS NOT NULL) AS rows_with_vector,
       (SELECT COUNT(*) FROM dim_empresas) AS total_rows;
