-- Migration 030: Index for CEP-based IBGE backfill
-- Description: Partial index on cep WHERE codigo_ibge IS NULL
-- Purpose: Accelerate backfill_ibge_turbo.js (~10x faster UPDATE by CEP)
-- Safe: CONCURRENTLY does not lock the table

-- Partial index: only rows that still need ibge
-- This index shrinks automatically as records are updated
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dim_empresas_cep_ibge_null
    ON dim_empresas(cep)
    WHERE codigo_ibge IS NULL AND cep IS NOT NULL AND cep != '';

-- Composite index for the UPDATE pattern used by the turbo script
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dim_empresas_cep_for_update
    ON dim_empresas(cep, codigo_ibge)
    WHERE codigo_ibge IS NULL;

COMMENT ON INDEX idx_dim_empresas_cep_ibge_null IS 'Partial index for CEP-based IBGE backfill. Drop after backfill completes.';
COMMENT ON INDEX idx_dim_empresas_cep_for_update IS 'Composite index for UPDATE by CEP. Drop after backfill completes.';
