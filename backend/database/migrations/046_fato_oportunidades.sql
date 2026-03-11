-- Migration 046: fato_oportunidades
-- Score de oportunidade + lead scoring com temperatura para cada relação empresa-empresa.

CREATE TABLE IF NOT EXISTS fato_oportunidades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem_id UUID NOT NULL REFERENCES dim_empresas(id),
  empresa_alvo_id UUID REFERENCES dim_empresas(id),
  nome_alvo TEXT,
  tipo_oportunidade TEXT NOT NULL,
  -- 'venda_direta', 'parceria', 'fornecimento', 'expansao_geografica'

  -- Score composto (0-100)
  score_oportunidade FLOAT NOT NULL,
  score_geografico FLOAT,
  score_cnae FLOAT,
  score_tributario FLOAT,
  score_temporal FLOAT,
  score_evidencia FLOAT,

  -- Pesos
  peso_geografico FLOAT DEFAULT 0.20,
  peso_cnae FLOAT DEFAULT 0.25,
  peso_tributario FLOAT DEFAULT 0.15,
  peso_temporal FLOAT DEFAULT 0.10,
  peso_evidencia FLOAT DEFAULT 0.30,

  -- Lead Scoring
  lead_temperatura TEXT, -- 'quente', 'morno', 'frio'
  lead_score FLOAT, -- 0-100
  lead_sinais JSONB,
  -- Ex: {"visitou_site": true, "mencionou_em_noticia": true, "mesmo_municipio": true}

  justificativa TEXT,
  acoes_recomendadas TEXT[],
  prioridade TEXT DEFAULT 'media',
  -- 'critica', 'alta', 'media', 'baixa'
  status TEXT DEFAULT 'nova',
  -- 'nova', 'em_analise', 'qualificada', 'descartada', 'convertida'

  contexto_id UUID REFERENCES dim_contextos(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oport_origem ON fato_oportunidades(empresa_origem_id);
CREATE INDEX IF NOT EXISTS idx_oport_alvo ON fato_oportunidades(empresa_alvo_id);
CREATE INDEX IF NOT EXISTS idx_oport_score ON fato_oportunidades(score_oportunidade DESC);
CREATE INDEX IF NOT EXISTS idx_oport_tipo ON fato_oportunidades(tipo_oportunidade);
CREATE INDEX IF NOT EXISTS idx_oport_prioridade ON fato_oportunidades(prioridade);
CREATE INDEX IF NOT EXISTS idx_oport_status ON fato_oportunidades(status);
CREATE INDEX IF NOT EXISTS idx_oport_temperatura ON fato_oportunidades(lead_temperatura);
CREATE INDEX IF NOT EXISTS idx_oport_contexto ON fato_oportunidades(contexto_id);
