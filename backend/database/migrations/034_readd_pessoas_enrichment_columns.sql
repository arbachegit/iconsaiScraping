-- Migration 034: Re-add enrichment columns to dim_pessoas
-- Date: 2026-03-10
--
-- Columns were removed by migrations 004 and 005 to normalize into
-- fato_transacao_empresas. However, people added via external search
-- (Apollo/Perplexity/Serper) don't have formal company links, so their
-- cargo, empresa, cidade etc. need to live directly on dim_pessoas.

-- ===========================================
-- 1. RE-ADD COLUMNS REMOVED BY MIGRATION 004
-- ===========================================

ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS cidade VARCHAR(100);
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS estado VARCHAR(2);
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS telefone VARCHAR(50);
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS empresa_atual_nome VARCHAR(255);
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS twitter_url VARCHAR(500);

-- ===========================================
-- 2. RE-ADD COLUMNS REMOVED BY MIGRATION 005
-- ===========================================

ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS cargo_atual VARCHAR(255);
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS headline VARCHAR(500);

-- ===========================================
-- 3. ADD NEW ENRICHMENT COLUMNS
-- ===========================================

ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS sobre TEXT;
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS senioridade VARCHAR(50);
ALTER TABLE dim_pessoas ADD COLUMN IF NOT EXISTS departamento VARCHAR(100);

-- ===========================================
-- 4. INDEXES FOR COMMON QUERIES
-- ===========================================

CREATE INDEX IF NOT EXISTS idx_dim_pessoas_cidade ON dim_pessoas(cidade);
CREATE INDEX IF NOT EXISTS idx_dim_pessoas_estado ON dim_pessoas(estado);
CREATE INDEX IF NOT EXISTS idx_dim_pessoas_cargo ON dim_pessoas(cargo_atual);
CREATE INDEX IF NOT EXISTS idx_dim_pessoas_empresa_nome ON dim_pessoas(empresa_atual_nome);

-- ===========================================
-- 5. COMMENTS
-- ===========================================

COMMENT ON COLUMN dim_pessoas.cidade IS 'Cidade da pessoa (extraida de localizacao)';
COMMENT ON COLUMN dim_pessoas.estado IS 'UF da pessoa (ex: SP, RJ)';
COMMENT ON COLUMN dim_pessoas.telefone IS 'Telefone principal (Apollo/manual)';
COMMENT ON COLUMN dim_pessoas.empresa_atual_nome IS 'Nome da empresa atual (texto livre, de fontes externas)';
COMMENT ON COLUMN dim_pessoas.cargo_atual IS 'Cargo atual da pessoa (Apollo/Perplexity/Serper)';
COMMENT ON COLUMN dim_pessoas.headline IS 'Headline do perfil LinkedIn';
COMMENT ON COLUMN dim_pessoas.sobre IS 'Resumo profissional / bio';
COMMENT ON COLUMN dim_pessoas.senioridade IS 'Nivel de senioridade (junior, pleno, senior, director, c-level)';
COMMENT ON COLUMN dim_pessoas.departamento IS 'Departamento principal (engineering, sales, marketing, etc)';
COMMENT ON COLUMN dim_pessoas.twitter_url IS 'URL do perfil Twitter/X';
