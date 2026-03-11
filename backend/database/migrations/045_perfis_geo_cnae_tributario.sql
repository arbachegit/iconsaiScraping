-- Migration 045: fato_perfil_geografico + fato_perfil_cnae + fato_perfil_tributario
-- Três tabelas de perfil analítico para cada empresa.

-- Perfil Geográfico
CREATE TABLE IF NOT EXISTS fato_perfil_geografico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES dim_empresas(id),
  arco_atuacao TEXT NOT NULL,
  -- 'local', 'municipal', 'estadual', 'regional', 'nacional', 'internacional'
  municipios_atuacao TEXT[],
  estados_atuacao TEXT[],
  raio_km NUMERIC,
  densidade_concorrentes INT,
  market_share_estimado FLOAT,
  populacao_alcancavel BIGINT,
  pib_regional NUMERIC,
  indice_saturacao FLOAT, -- 0-1
  oportunidades_geograficas JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pgeo_empresa ON fato_perfil_geografico(empresa_id);
CREATE INDEX IF NOT EXISTS idx_pgeo_arco ON fato_perfil_geografico(arco_atuacao);

-- Perfil CNAE
CREATE TABLE IF NOT EXISTS fato_perfil_cnae (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES dim_empresas(id),
  cnae_principal TEXT NOT NULL,
  cnae_descricao TEXT,
  cnaes_secundarios TEXT[],
  setor_economico TEXT,
  -- 'industria', 'comercio', 'servicos', 'agro', 'construcao', 'mineracao'
  cadeia_valor TEXT,
  -- 'producao', 'distribuicao', 'varejo', 'servicos'
  posicao_cadeia TEXT,
  -- 'inicio', 'meio', 'fim'
  cnaes_clientes_tipicos TEXT[],
  cnaes_fornecedores_tipicos TEXT[],
  cnaes_concorrentes TEXT[],
  total_empresas_mesmo_cnae_municipio INT,
  total_empresas_mesmo_cnae_estado INT,
  total_empresas_mesmo_cnae_brasil INT,
  ranking_municipal INT,
  ranking_estadual INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcnae_empresa ON fato_perfil_cnae(empresa_id);
CREATE INDEX IF NOT EXISTS idx_pcnae_principal ON fato_perfil_cnae(cnae_principal);
CREATE INDEX IF NOT EXISTS idx_pcnae_setor ON fato_perfil_cnae(setor_economico);

-- Perfil Tributário
CREATE TABLE IF NOT EXISTS fato_perfil_tributario (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES dim_empresas(id),
  regime_tributario TEXT,
  porte TEXT, -- 'MEI', 'ME', 'EPP', 'MEDIO', 'GRANDE'
  faturamento_estimado_min NUMERIC,
  faturamento_estimado_max NUMERIC,
  capital_social NUMERIC,
  idade_empresa_anos INT,
  quantidade_socios INT,
  quantidade_funcionarios_estimado INT,
  score_saude_fiscal FLOAT, -- 0-1
  perfil_comprador TEXT,
  -- 'price_sensitive', 'value_oriented', 'premium'
  poder_compra_estimado TEXT,
  -- 'baixo', 'medio', 'alto', 'muito_alto'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ptrib_empresa ON fato_perfil_tributario(empresa_id);
CREATE INDEX IF NOT EXISTS idx_ptrib_regime ON fato_perfil_tributario(regime_tributario);
CREATE INDEX IF NOT EXISTS idx_ptrib_porte ON fato_perfil_tributario(porte);
CREATE INDEX IF NOT EXISTS idx_ptrib_comprador ON fato_perfil_tributario(perfil_comprador);
