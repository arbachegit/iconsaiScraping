-- Migration 044: dim_datas_comemorativas
-- Datas relevantes para cada empresa (aniversário, eventos, sazonalidade).

CREATE TABLE IF NOT EXISTS dim_datas_comemorativas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES dim_empresas(id),
  tipo TEXT NOT NULL,
  -- 'aniversario_empresa', 'evento_setor', 'sazonalidade', 'data_fiscal'
  nome TEXT NOT NULL,
  data_referencia DATE,
  mes_referencia INT,
  descricao TEXT,
  relevancia TEXT DEFAULT 'media', -- 'alta', 'media', 'baixa'
  cnae_relacionado TEXT,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_datas_empresa ON dim_datas_comemorativas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_datas_tipo ON dim_datas_comemorativas(tipo);
CREATE INDEX IF NOT EXISTS idx_datas_mes ON dim_datas_comemorativas(mes_referencia);
CREATE INDEX IF NOT EXISTS idx_datas_cnae ON dim_datas_comemorativas(cnae_relacionado);
