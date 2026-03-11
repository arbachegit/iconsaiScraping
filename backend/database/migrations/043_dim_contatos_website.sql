-- Migration 043: dim_contatos_website
-- Contatos extraídos dos websites (emails, telefones, redes sociais).

CREATE TABLE IF NOT EXISTS dim_contatos_website (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES dim_empresas(id),
  tipo TEXT NOT NULL,
  -- 'email', 'telefone', 'whatsapp', 'linkedin', 'instagram', 'facebook', 'twitter'
  valor TEXT NOT NULL,
  departamento TEXT, -- 'comercial', 'suporte', 'rh', 'geral'
  pessoa_nome TEXT,
  pessoa_id UUID REFERENCES dim_pessoas(id),
  principal BOOLEAN DEFAULT false,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  fonte TEXT DEFAULT 'gemini_crawl'
);

CREATE INDEX IF NOT EXISTS idx_contatos_empresa ON dim_contatos_website(empresa_id);
CREATE INDEX IF NOT EXISTS idx_contatos_tipo ON dim_contatos_website(tipo);
CREATE INDEX IF NOT EXISTS idx_contatos_pessoa ON dim_contatos_website(pessoa_id);
