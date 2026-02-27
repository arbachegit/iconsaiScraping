-- Migration: 012_stats_historico.sql
-- Descricao: Tabela para historico de estatisticas do dashboard
-- Data: 2026-02-23
-- Autor: IconsAI

-- Criar tabela stats_historico (se nao existir)
CREATE TABLE IF NOT EXISTS stats_historico (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data DATE NOT NULL,
    categoria TEXT NOT NULL CHECK (categoria IN ('empresas', 'pessoas', 'politicos', 'mandatos', 'emendas', 'noticias')),
    total INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraint unica para evitar duplicatas
    UNIQUE(data, categoria)
);

-- Comentarios
COMMENT ON TABLE stats_historico IS 'Historico diario de contagens para dashboard badges';
COMMENT ON COLUMN stats_historico.data IS 'Data do snapshot (YYYY-MM-DD)';
COMMENT ON COLUMN stats_historico.categoria IS 'Categoria: empresas, pessoas, politicos, mandatos, emendas, noticias';
COMMENT ON COLUMN stats_historico.total IS 'Total acumulado na data';

-- Indices para performance
CREATE INDEX IF NOT EXISTS idx_stats_historico_data ON stats_historico(data);
CREATE INDEX IF NOT EXISTS idx_stats_historico_categoria ON stats_historico(categoria);
CREATE INDEX IF NOT EXISTS idx_stats_historico_data_categoria ON stats_historico(data, categoria);

-- Registrar fonte de dados (compliance ISO 27001)
INSERT INTO fontes_dados (
    nome,
    categoria,
    fonte_primaria,
    url,
    confiabilidade,
    api_key_necessaria,
    periodicidade,
    formato
) VALUES (
    'Stats Historico - Dashboard',
    'interno',
    'IconsAI Scraping',
    'internal://stats_historico',
    'alta',
    false,
    'a cada 5 minutos',
    'PostgreSQL'
) ON CONFLICT (nome) DO NOTHING;
