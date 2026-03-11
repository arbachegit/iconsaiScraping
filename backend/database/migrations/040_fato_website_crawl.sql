-- Migration 040: fato_website_crawl
-- Armazena o resultado do crawl Gemini de cada website empresarial.

CREATE TABLE IF NOT EXISTS fato_website_crawl (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES dim_empresas(id),
  url TEXT NOT NULL,
  status TEXT DEFAULT 'pendente',
  -- 'pendente', 'crawling', 'sucesso', 'erro', 'sem_website'
  raw_extraction JSONB,
  resumo_atividade TEXT,
  segmento_detectado TEXT,
  porte_estimado TEXT,
  palavras_chave TEXT[],
  tecnologias_detectadas TEXT[],
  idiomas TEXT[],
  tem_ecommerce BOOLEAN DEFAULT false,
  tem_blog BOOLEAN DEFAULT false,
  tem_area_cliente BOOLEAN DEFAULT false,
  ultima_atualizacao_site TIMESTAMPTZ,
  taxonomia_id UUID REFERENCES dim_taxonomia_empresa(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  fonte TEXT DEFAULT 'gemini_crawl'
);

CREATE INDEX IF NOT EXISTS idx_wcrawl_empresa ON fato_website_crawl(empresa_id);
CREATE INDEX IF NOT EXISTS idx_wcrawl_status ON fato_website_crawl(status);
CREATE INDEX IF NOT EXISTS idx_wcrawl_segmento ON fato_website_crawl(segmento_detectado);
CREATE INDEX IF NOT EXISTS idx_wcrawl_taxonomia ON fato_website_crawl(taxonomia_id);
