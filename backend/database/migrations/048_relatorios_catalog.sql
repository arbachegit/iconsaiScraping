-- Migration 048: Report Catalog + Context Mapping
-- Tables for storing generated BI reports and mapping them to analysis contexts.

-- ============================================================
-- dim_relatorios — Report definitions (catalog)
-- ============================================================
CREATE TABLE IF NOT EXISTS dim_relatorios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identification
  codigo TEXT NOT NULL UNIQUE,        -- e.g. 'prospeccao_comercial', 'risk_fornecedor'
  nome TEXT NOT NULL,                 -- Display name
  descricao TEXT,                     -- Description
  categoria TEXT NOT NULL,            -- 'analise_empresa', 'analise_rede', 'analise_oportunidade', 'analise_risco'

  -- Template
  template_sections JSONB NOT NULL DEFAULT '[]',  -- Array of section definitions
  parametros_obrigatorios JSONB DEFAULT '[]',     -- Required input params

  -- Metadata
  versao INTEGER NOT NULL DEFAULT 1,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_relatorios_codigo ON dim_relatorios(codigo);
CREATE INDEX IF NOT EXISTS idx_relatorios_categoria ON dim_relatorios(categoria);

-- ============================================================
-- map_contexto_relatorio — Maps contexts to reports
-- ============================================================
CREATE TABLE IF NOT EXISTS map_contexto_relatorio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contexto_id UUID NOT NULL REFERENCES dim_contextos(id) ON DELETE CASCADE,
  relatorio_id UUID NOT NULL REFERENCES dim_relatorios(id) ON DELETE CASCADE,
  prioridade INTEGER NOT NULL DEFAULT 0,  -- Higher = more relevant for that context
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(contexto_id, relatorio_id)
);

CREATE INDEX IF NOT EXISTS idx_map_ctx_rel_contexto ON map_contexto_relatorio(contexto_id);
CREATE INDEX IF NOT EXISTS idx_map_ctx_rel_relatorio ON map_contexto_relatorio(relatorio_id);

-- ============================================================
-- fato_relatorios_gerados — Generated report instances
-- ============================================================
CREATE TABLE IF NOT EXISTS fato_relatorios_gerados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Report definition
  relatorio_id UUID NOT NULL REFERENCES dim_relatorios(id),

  -- Target entity
  entidade_type TEXT NOT NULL,
  entidade_id UUID NOT NULL,

  -- Content
  titulo TEXT NOT NULL,
  resumo TEXT,                          -- Executive summary
  sections JSONB NOT NULL DEFAULT '[]', -- Array of rendered sections
  metricas JSONB DEFAULT '{}',          -- Key metrics snapshot
  score_geral NUMERIC(5,2),             -- Overall score (0-100)

  -- Graph analytics snapshot
  graph_analytics JSONB DEFAULT '{}',   -- Centrality, clustering, etc.

  -- Status
  status TEXT NOT NULL DEFAULT 'gerado', -- 'gerado', 'revisado', 'arquivado'
  gerado_por TEXT DEFAULT 'sistema',

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,               -- Optional TTL
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rel_gerados_entidade ON fato_relatorios_gerados(entidade_type, entidade_id);
CREATE INDEX IF NOT EXISTS idx_rel_gerados_relatorio ON fato_relatorios_gerados(relatorio_id);
CREATE INDEX IF NOT EXISTS idx_rel_gerados_status ON fato_relatorios_gerados(status);
CREATE INDEX IF NOT EXISTS idx_rel_gerados_created ON fato_relatorios_gerados(created_at DESC);

-- ============================================================
-- Seed: Report catalog
-- ============================================================
INSERT INTO dim_relatorios (codigo, nome, descricao, categoria, template_sections) VALUES
  ('perfil_completo', 'Perfil Completo da Empresa', 'Visão 360° com dados cadastrais, fiscais, CNAE, ecossistema e oportunidades', 'analise_empresa',
   '[{"key":"resumo","titulo":"Resumo Executivo","tipo":"texto"},{"key":"cadastral","titulo":"Dados Cadastrais","tipo":"tabela"},{"key":"fiscal","titulo":"Perfil Fiscal","tipo":"tabela"},{"key":"cnae","titulo":"Classificação CNAE","tipo":"tabela"},{"key":"ecossistema","titulo":"Ecossistema","tipo":"lista"},{"key":"oportunidades","titulo":"Oportunidades","tipo":"lista_scored"},{"key":"grafo","titulo":"Análise de Rede","tipo":"graph_analytics"}]'),

  ('analise_rede', 'Análise de Rede', 'Centralidade, clusters e influência no grafo de relações', 'analise_rede',
   '[{"key":"resumo","titulo":"Resumo da Rede","tipo":"texto"},{"key":"centralidade","titulo":"Métricas de Centralidade","tipo":"tabela"},{"key":"comunidades","titulo":"Comunidades Detectadas","tipo":"lista"},{"key":"influenciadores","titulo":"Nós Influenciadores","tipo":"lista_scored"},{"key":"caminhos","titulo":"Caminhos Críticos","tipo":"lista"}]'),

  ('prospeccao_comercial', 'Relatório de Prospecção Comercial', 'Oportunidades de venda, leads quentes e ações recomendadas', 'analise_oportunidade',
   '[{"key":"resumo","titulo":"Resumo de Prospecção","tipo":"texto"},{"key":"leads_quentes","titulo":"Leads Quentes","tipo":"lista_scored"},{"key":"leads_mornos","titulo":"Leads Mornos","tipo":"lista_scored"},{"key":"acoes","titulo":"Ações Recomendadas","tipo":"lista"},{"key":"pipeline","titulo":"Pipeline de Oportunidades","tipo":"tabela"}]'),

  ('risco_fornecedor', 'Análise de Risco de Fornecedor', 'Avaliação de risco, saúde fiscal e dependências', 'analise_risco',
   '[{"key":"resumo","titulo":"Resumo de Risco","tipo":"texto"},{"key":"saude_fiscal","titulo":"Saúde Fiscal","tipo":"tabela"},{"key":"dependencias","titulo":"Dependências","tipo":"lista"},{"key":"alertas","titulo":"Alertas","tipo":"lista"},{"key":"score_risco","titulo":"Score de Risco","tipo":"score"}]'),

  ('mapa_concorrencia', 'Mapa de Concorrência', 'Concorrentes diretos, market share estimado e posicionamento', 'analise_empresa',
   '[{"key":"resumo","titulo":"Resumo Competitivo","tipo":"texto"},{"key":"concorrentes","titulo":"Concorrentes Diretos","tipo":"lista_scored"},{"key":"market_share","titulo":"Market Share Estimado","tipo":"tabela"},{"key":"diferenciadores","titulo":"Diferenciadores","tipo":"lista"},{"key":"geografico","titulo":"Distribuição Geográfica","tipo":"tabela"}]'),

  ('due_diligence', 'Due Diligence', 'Análise completa para avaliação de parceria ou aquisição', 'analise_risco',
   '[{"key":"resumo","titulo":"Resumo Due Diligence","tipo":"texto"},{"key":"cadastral","titulo":"Análise Cadastral","tipo":"tabela"},{"key":"socios","titulo":"Quadro Societário","tipo":"lista"},{"key":"fiscal","titulo":"Análise Fiscal","tipo":"tabela"},{"key":"rede","titulo":"Rede de Relações","tipo":"graph_analytics"},{"key":"alertas","titulo":"Red Flags","tipo":"lista"},{"key":"score","titulo":"Score Final","tipo":"score"}]')

ON CONFLICT (codigo) DO NOTHING;

-- ============================================================
-- Seed: Context-Report mappings
-- ============================================================
INSERT INTO map_contexto_relatorio (contexto_id, relatorio_id, prioridade)
SELECT c.id, r.id, m.prioridade
FROM (VALUES
  ('prospeccao_comercial', 'prospeccao_comercial', 10),
  ('prospeccao_comercial', 'perfil_completo', 5),
  ('analise_fornecedor', 'risco_fornecedor', 10),
  ('analise_fornecedor', 'perfil_completo', 5),
  ('analise_concorrente', 'mapa_concorrencia', 10),
  ('analise_concorrente', 'analise_rede', 5),
  ('due_diligence', 'due_diligence', 10),
  ('due_diligence', 'perfil_completo', 8),
  ('due_diligence', 'analise_rede', 5),
  ('mapeamento_mercado', 'mapa_concorrencia', 10),
  ('mapeamento_mercado', 'analise_rede', 8),
  ('gestao_risco', 'risco_fornecedor', 10),
  ('gestao_risco', 'due_diligence', 8),
  ('inteligencia_competitiva', 'mapa_concorrencia', 10),
  ('inteligencia_competitiva', 'analise_rede', 8),
  ('inteligencia_competitiva', 'perfil_completo', 5)
) AS m(contexto_codigo, relatorio_codigo, prioridade)
JOIN dim_contextos c ON c.codigo = m.contexto_codigo
JOIN dim_relatorios r ON r.codigo = m.relatorio_codigo
ON CONFLICT (contexto_id, relatorio_id) DO NOTHING;
