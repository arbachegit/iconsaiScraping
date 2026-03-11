-- Migration 041: dim_ecossistema_empresas
-- Mapa de relacionamentos entre empresas (cliente, fornecedor, concorrente, parceiro).
-- Evidências centralizadas via FK para fato_evidencias.

CREATE TABLE IF NOT EXISTS dim_ecossistema_empresas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES dim_empresas(id),
  empresa_relacionada_id UUID REFERENCES dim_empresas(id),
  nome_empresa_relacionada TEXT NOT NULL,
  cnpj_relacionada TEXT,
  tipo_relacao TEXT NOT NULL,
  -- 'cliente', 'fornecedor', 'concorrente', 'parceiro'
  subtipo TEXT,
  -- 'cliente_direto', 'cliente_indireto', 'fornecedor_materia_prima', etc.
  fonte_deteccao TEXT NOT NULL,
  -- 'website', 'cnae', 'geografico', 'noticia', 'societario'
  evidencia_id UUID REFERENCES fato_evidencias(id),
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eco_empresa ON dim_ecossistema_empresas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_eco_tipo ON dim_ecossistema_empresas(tipo_relacao);
CREATE INDEX IF NOT EXISTS idx_eco_relacionada ON dim_ecossistema_empresas(empresa_relacionada_id);
CREATE INDEX IF NOT EXISTS idx_eco_evidencia ON dim_ecossistema_empresas(evidencia_id);
CREATE INDEX IF NOT EXISTS idx_eco_fonte ON dim_ecossistema_empresas(fonte_deteccao);
