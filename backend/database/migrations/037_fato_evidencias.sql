-- Migration 037: fato_evidencias (centralizada)
-- Todas as evidências do sistema passam por aqui.
-- Substitui campos espalhados de evidencia/confianca em outras tabelas.

CREATE TABLE IF NOT EXISTS fato_evidencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entidade_origem_type TEXT NOT NULL,
  entidade_origem_id UUID NOT NULL,
  entidade_destino_type TEXT,
  entidade_destino_id UUID,
  tipo_evidencia TEXT NOT NULL,
  -- 'mencao_website', 'relacao_societaria', 'contrato_publico',
  -- 'mencao_noticia', 'correlacao_cnae', 'proximidade_geo',
  -- 'inferencia_gemini', 'dado_cadastral'
  fonte TEXT NOT NULL,
  -- 'gemini_crawl', 'cnae_correlacao', 'geo_analise',
  -- 'noticia', 'societario', 'brasilapi', 'apollo'
  confianca FLOAT NOT NULL DEFAULT 0.5,
  metodo_extracao TEXT,
  -- 'ai_extraction', 'rule_based', 'statistical', 'manual'
  texto_evidencia TEXT,
  metadata JSONB,
  expires_at TIMESTAMPTZ,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidencias_origem ON fato_evidencias(entidade_origem_type, entidade_origem_id);
CREATE INDEX IF NOT EXISTS idx_evidencias_destino ON fato_evidencias(entidade_destino_type, entidade_destino_id);
CREATE INDEX IF NOT EXISTS idx_evidencias_tipo ON fato_evidencias(tipo_evidencia);
CREATE INDEX IF NOT EXISTS idx_evidencias_fonte ON fato_evidencias(fonte);
CREATE INDEX IF NOT EXISTS idx_evidencias_confianca ON fato_evidencias(confianca);
CREATE INDEX IF NOT EXISTS idx_evidencias_ativo ON fato_evidencias(ativo) WHERE ativo = true;
