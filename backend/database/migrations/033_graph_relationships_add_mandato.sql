-- Migration 033: expand graph schema to support mandato entities and extra relation types

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'fato_relacoes_entidades'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%source_type%'
  LOOP
    EXECUTE format('ALTER TABLE fato_relacoes_entidades DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'fato_relacoes_entidades'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%target_type%'
  LOOP
    EXECUTE format('ALTER TABLE fato_relacoes_entidades DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'fato_relacoes_entidades'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%tipo_relacao%'
  LOOP
    EXECUTE format('ALTER TABLE fato_relacoes_entidades DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE fato_relacoes_entidades
  ADD CONSTRAINT chk_rel_source_type
  CHECK (source_type IN ('empresa', 'pessoa', 'politico', 'mandato', 'emenda', 'noticia'));

ALTER TABLE fato_relacoes_entidades
  ADD CONSTRAINT chk_rel_target_type
  CHECK (target_type IN ('empresa', 'pessoa', 'politico', 'mandato', 'emenda', 'noticia'));

ALTER TABLE fato_relacoes_entidades
  ADD CONSTRAINT chk_rel_tipo
  CHECK (tipo_relacao IN (
    'societaria',
    'fornecedor',
    'concorrente',
    'parceiro',
    'regulador',
    'beneficiario',
    'mencionado_em',
    'cnae_similar',
    'geografico',
    'politico_empresarial',
    'emenda_beneficiario',
    'mandato'
  ));

COMMENT ON TABLE fato_relacoes_entidades IS 'Grafo polimórfico de relacionamentos entre entidades (empresa, pessoa, político, mandato, emenda, notícia)';
COMMENT ON COLUMN fato_relacoes_entidades.source_type IS 'Tipo da entidade origem (empresa, pessoa, politico, mandato, emenda, noticia)';
COMMENT ON COLUMN fato_relacoes_entidades.target_type IS 'Tipo da entidade destino (empresa, pessoa, politico, mandato, emenda, noticia)';
COMMENT ON COLUMN fato_relacoes_entidades.tipo_relacao IS 'Tipo do relacionamento (societaria, fornecedor, concorrente, parceiro, regulador, beneficiario, mencionado_em, cnae_similar, geografico, politico_empresarial, emenda_beneficiario, mandato)';
