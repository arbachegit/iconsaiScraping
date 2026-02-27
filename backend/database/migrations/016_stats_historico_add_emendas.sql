-- Migration: 016_stats_historico_add_emendas.sql
-- Descricao: Adiciona categorias 'mandatos' e 'emendas' ao CHECK constraint de stats_historico
-- Data: 2026-02-27
-- Autor: IconsAI

-- Remover CHECK constraint antigo (so permite empresas, pessoas, politicos, noticias)
ALTER TABLE stats_historico DROP CONSTRAINT IF EXISTS stats_historico_categoria_check;

-- Adicionar CHECK constraint atualizado com todas as 6 categorias
ALTER TABLE stats_historico ADD CONSTRAINT stats_historico_categoria_check
  CHECK (categoria IN ('empresas', 'pessoas', 'politicos', 'mandatos', 'emendas', 'noticias'));

-- Atualizar comentario
COMMENT ON COLUMN stats_historico.categoria IS 'Categoria: empresas, pessoas, politicos, mandatos, emendas, noticias';
