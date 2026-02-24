-- Migration: 016_add_mandatos_category.sql
-- Descricao: Adicionar 'mandatos' como categoria valida em stats_historico
-- Data: 2026-02-24
-- Autor: IconsAI

-- Remover TODOS os CHECK constraints da tabela (nome pode variar)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'stats_historico'::regclass
      AND contype = 'c'
  LOOP
    EXECUTE 'ALTER TABLE stats_historico DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

-- Adicionar nova constraint com mandatos
ALTER TABLE stats_historico
ADD CONSTRAINT stats_historico_categoria_check
CHECK (categoria IN ('empresas', 'pessoas', 'politicos', 'mandatos', 'noticias'));

-- Comentario atualizado
COMMENT ON COLUMN stats_historico.categoria IS 'Categoria: empresas, pessoas, politicos, mandatos, noticias';
