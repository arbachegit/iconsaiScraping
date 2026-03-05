-- =============================================
-- FASE 1 - PARTE 3a/5: Criar coluna + trigger (SEM update)
-- Executar no Supabase SQL Editor
-- Tempo estimado: < 5s
-- =============================================

-- 1. Adicionar coluna search_vector
ALTER TABLE dim_empresas ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 2. Trigger para auto-update em novos INSERT/UPDATE
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

-- 3. pgvector (condicional)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        EXECUTE 'ALTER TABLE dim_empresas ADD COLUMN IF NOT EXISTS embedding vector(1536)';
    ELSE
        RAISE NOTICE 'pgvector not enabled. Skipping embedding column.';
    END IF;
END $$;

COMMENT ON COLUMN dim_empresas.search_vector IS 'Full-text search vector (Portuguese) for fast text queries';

SELECT 'PARTE 3a OK - coluna e trigger criados' AS status;
