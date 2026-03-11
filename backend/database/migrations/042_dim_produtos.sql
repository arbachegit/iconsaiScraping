-- Migration 042: dim_produtos
-- Produtos e serviços oferecidos por cada empresa.

CREATE TABLE IF NOT EXISTS dim_produtos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES dim_empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  categoria TEXT,
  subcategoria TEXT,
  tipo TEXT DEFAULT 'produto', -- 'produto', 'servico'
  preco_detectado NUMERIC,
  moeda TEXT DEFAULT 'BRL',
  url_produto TEXT,
  taxonomia_id UUID REFERENCES dim_taxonomia_empresa(id),
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  fonte TEXT DEFAULT 'gemini_crawl'
);

CREATE INDEX IF NOT EXISTS idx_prod_empresa ON dim_produtos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_prod_categoria ON dim_produtos(categoria);
CREATE INDEX IF NOT EXISTS idx_prod_taxonomia ON dim_produtos(taxonomia_id);
CREATE INDEX IF NOT EXISTS idx_prod_tipo ON dim_produtos(tipo);
