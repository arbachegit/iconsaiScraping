-- Migration 047: Temporal tracking em fato_relacoes_entidades
-- Adiciona valid_from/valid_to para rastreamento temporal de relações.

ALTER TABLE fato_relacoes_entidades
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ; -- NULL = ainda válido

CREATE INDEX IF NOT EXISTS idx_relacoes_temporal ON fato_relacoes_entidades(valid_from, valid_to);

COMMENT ON COLUMN fato_relacoes_entidades.valid_from IS 'Início da validade da relação';
COMMENT ON COLUMN fato_relacoes_entidades.valid_to IS 'Fim da validade (NULL = ativo)';
