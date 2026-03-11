-- Migration 038: dim_contextos + fato_empresa_contexto
-- Camada de contexto analítico: define em qual perspectiva uma empresa é analisada.

CREATE TABLE IF NOT EXISTS dim_contextos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  descricao TEXT,
  relatorios_aplicaveis TEXT[],
  dados_minimos_requeridos TEXT[],
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fato_empresa_contexto (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES dim_empresas(id),
  contexto_id UUID NOT NULL REFERENCES dim_contextos(id),
  atribuido_por TEXT DEFAULT 'sistema',
  prioridade TEXT DEFAULT 'media',
  notas TEXT,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, contexto_id)
);

CREATE INDEX IF NOT EXISTS idx_empresa_contexto_empresa ON fato_empresa_contexto(empresa_id);
CREATE INDEX IF NOT EXISTS idx_empresa_contexto_contexto ON fato_empresa_contexto(contexto_id);

-- Seed: 12 contextos
INSERT INTO dim_contextos (codigo, nome, descricao, relatorios_aplicaveis, dados_minimos_requeridos) VALUES
('prospeccao_comercial', 'Prospecção Comercial', 'Analisar empresa como potencial cliente', ARRAY['score_oportunidade', 'matriz_valor_esforco', 'ecossistema', 'perfil_tributario'], ARRAY['fato_perfil_cnae', 'fato_perfil_tributario']),
('fornecedor', 'Fornecedor', 'Avaliar empresa como possível fornecedor', ARRAY['dependencia_fornecedores', 'cadeia_valor', 'matriz_risco'], ARRAY['fato_perfil_cnae', 'dim_ecossistema_empresas']),
('concorrente', 'Concorrência', 'Identificar competidores diretos e indiretos', ARRAY['swot', 'clusters_mercado', 'centralidade_rede'], ARRAY['fato_perfil_cnae', 'fato_perfil_geografico']),
('parceiro', 'Parceria Estratégica', 'Buscar alianças ou cooperação', ARRAY['ecossistema', 'cadeia_valor', 'score_oportunidade'], ARRAY['fato_perfil_cnae', 'dim_ecossistema_empresas']),
('expansao_geografica', 'Expansão Geográfica', 'Avaliar oportunidades territoriais', ARRAY['mapa_expansao', 'saturacao_mercado', 'analise_populacional'], ARRAY['fato_perfil_geografico']),
('risco_compliance', 'Risco e Compliance', 'Detectar vulnerabilidades', ARRAY['matriz_risco', 'pontos_falha', 'score_saude_fiscal'], ARRAY['fato_perfil_tributario', 'fato_evidencias']),
('ecossistema', 'Ecossistema Empresarial', 'Mapear clientes, fornecedores e parceiros', ARRAY['comunidades', 'hubs_empresariais', 'caminhos_indiretos'], ARRAY['dim_ecossistema_empresas', 'fato_relacoes_entidades']),
('inteligencia_reputacional', 'Inteligência Reputacional', 'Avaliar presença em notícias e eventos', ARRAY['evolucao_rede', 'deteccao_eventos', 'sentimento'], ARRAY['dim_noticias', 'fato_evidencias']),
('cadeia_valor', 'Cadeia de Valor', 'Mapear posição na cadeia produtiva', ARRAY['cadeia_producao', 'dependencia_fornecedores', 'centralidade_rede'], ARRAY['fato_perfil_cnae', 'dim_ecossistema_empresas']),
('priorizacao', 'Priorização Estratégica', 'Decidir onde investir esforço', ARRAY['eisenhower', 'matriz_valor_esforco', 'score_oportunidade'], ARRAY['fato_oportunidades']),
('monitoramento', 'Monitoramento Contínuo', 'Detectar mudanças ao longo do tempo', ARRAY['evolucao_rede', 'deteccao_eventos', 'alertas'], ARRAY['fato_evidencias', 'fato_relacoes_entidades']),
('due_diligence', 'Due Diligence', 'Avaliação preliminar completa', ARRAY['swot', 'ecossistema', 'matriz_risco', 'perfil_tributario', 'centralidade_rede'], ARRAY['fato_perfil_cnae', 'fato_perfil_tributario', 'fato_perfil_geografico', 'fato_evidencias'])
ON CONFLICT (codigo) DO NOTHING;
