-- Migration 035: Replace cidade/estado text columns with codigo_ibge/codigo_ibge_uf in dim_pessoas
-- The text columns are empty (0/22M rows populated), so no data conversion needed.

-- Step 1: Add new IBGE columns
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS codigo_ibge TEXT;
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS codigo_ibge_uf TEXT;

-- Step 2: Create indexes for geographic lookups
CREATE INDEX IF NOT EXISTS idx_dim_pessoas_codigo_ibge ON dim_pessoas (codigo_ibge);
CREATE INDEX IF NOT EXISTS idx_dim_pessoas_codigo_ibge_uf ON dim_pessoas (codigo_ibge_uf);

-- Step 3: Drop empty text columns
ALTER TABLE dim_pessoas DROP COLUMN IF EXISTS cidade;
ALTER TABLE dim_pessoas DROP COLUMN IF EXISTS estado;
