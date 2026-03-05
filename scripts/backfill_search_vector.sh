#!/usr/bin/env bash
set -euo pipefail

# =============================================
# BACKFILL search_vector em dim_empresas
# Processa 64M rows em batches de 200K
# Tempo estimado: 2-4 horas
#
# USO:
#   chmod +x scripts/backfill_search_vector.sh
#   ./scripts/backfill_search_vector.sh
#
# Pode ser interrompido e retomado (idempotente).
# =============================================

echo "=========================================="
echo "BACKFILL search_vector - $(date)"
echo "=========================================="

# ------------------------------------------
# CREDENCIAIS
# ------------------------------------------
echo "[INIT] Obtendo credenciais via Supabase CLI..."
DUMP_OUTPUT=$(supabase db dump --dry-run 2>&1)

export PGHOST=$(echo "$DUMP_OUTPUT" | grep 'export PGHOST=' | head -1 | sed 's/export PGHOST="//' | sed 's/"//')
export PGPORT=$(echo "$DUMP_OUTPUT" | grep 'export PGPORT=' | head -1 | sed 's/export PGPORT="//' | sed 's/"//')
export PGUSER=$(echo "$DUMP_OUTPUT" | grep 'export PGUSER=' | head -1 | sed 's/export PGUSER="//' | sed 's/"//')
export PGPASSWORD=$(echo "$DUMP_OUTPUT" | grep 'export PGPASSWORD=' | head -1 | sed 's/export PGPASSWORD="//' | sed 's/"//')
export PGDATABASE=$(echo "$DUMP_OUTPUT" | grep 'export PGDATABASE=' | head -1 | sed 's/export PGDATABASE="//' | sed 's/"//')

if [ -z "$PGHOST" ] || [ -z "$PGPASSWORD" ]; then
  echo "ERRO: Nao foi possivel obter credenciais. Execute 'supabase login' primeiro."
  exit 1
fi

# ------------------------------------------
# STEP 1: Adicionar coluna + trigger
# ------------------------------------------
echo ""
echo "[STEP 1] Adicionar coluna search_vector e trigger..."

psql -c "SET SESSION ROLE postgres; SET statement_timeout = '0';
ALTER TABLE dim_empresas ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION update_empresas_search_vector()
RETURNS TRIGGER AS \$\$
BEGIN
    NEW.search_vector := (
        setweight(to_tsvector('portuguese', COALESCE(NEW.razao_social, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.nome_fantasia, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.cidade, '')), 'C') ||
        setweight(to_tsvector('portuguese', COALESCE(NEW.estado, '')), 'C')
    );
    RETURN NEW;
END;
\$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_empresas_search_vector ON dim_empresas;
CREATE TRIGGER trg_empresas_search_vector
    BEFORE INSERT OR UPDATE OF razao_social, nome_fantasia, cidade, estado
    ON dim_empresas
    FOR EACH ROW
    EXECUTE FUNCTION update_empresas_search_vector();
" 2>&1

echo "  Coluna e trigger criados."

# ------------------------------------------
# STEP 2: Backfill em batches
# ------------------------------------------
BATCH_SIZE=200000
TOTAL_ESTIMATED=64500000
batch_num=0
total_updated=0

echo ""
echo "[STEP 2] Backfill em batches de ${BATCH_SIZE}..."
echo "  Total estimado: ${TOTAL_ESTIMATED} rows"
echo "  Batches estimados: $((TOTAL_ESTIMATED / BATCH_SIZE))"
echo ""

while true; do
  batch_num=$((batch_num + 1))
  start_time=$(date +%s)

  # UPDATE com subquery limitada - processa exatamente BATCH_SIZE rows por vez
  result=$(psql -t -A -c "SET SESSION ROLE postgres; SET statement_timeout = '300000';
    WITH batch AS (
      SELECT id FROM dim_empresas
      WHERE search_vector IS NULL
      LIMIT ${BATCH_SIZE}
    )
    UPDATE dim_empresas e
    SET search_vector = (
        setweight(to_tsvector('portuguese', COALESCE(e.razao_social, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(e.nome_fantasia, '')), 'A') ||
        setweight(to_tsvector('portuguese', COALESCE(e.cidade, '')), 'C') ||
        setweight(to_tsvector('portuguese', COALESCE(e.estado, '')), 'C')
    )
    FROM batch
    WHERE e.id = batch.id;
    SELECT COUNT(*) FROM dim_empresas WHERE search_vector IS NULL LIMIT 1;
  " 2>&1)

  end_time=$(date +%s)
  elapsed=$((end_time - start_time))
  total_updated=$((total_updated + BATCH_SIZE))

  # Extrair remaining count do output
  remaining=$(echo "$result" | grep -E '^[0-9]+$' | tail -1)

  # Calcular progresso
  if [ -n "$remaining" ] && [ "$remaining" -gt 0 ]; then
    done_count=$((TOTAL_ESTIMATED - remaining))
    pct=$((done_count * 100 / TOTAL_ESTIMATED))
    eta_batches=$((remaining / BATCH_SIZE))
    eta_seconds=$((eta_batches * elapsed))
    eta_minutes=$((eta_seconds / 60))

    echo "  Batch #${batch_num}: ${elapsed}s | ~${pct}% done | ~${remaining} remaining | ETA: ~${eta_minutes}min"
  else
    echo "  Batch #${batch_num}: ${elapsed}s | Verificando se completo..."
  fi

  # Checar se terminou
  if [ -n "$remaining" ] && [ "$remaining" -eq 0 ]; then
    echo ""
    echo "  BACKFILL COMPLETO! Total batches: ${batch_num}"
    break
  fi

  # Safety: se o remaining nao mudou ou eh invalido, algo deu errado
  if [ -z "$remaining" ]; then
    echo "  AVISO: Nao foi possivel determinar remaining. Continuando..."
  fi
done

# ------------------------------------------
# STEP 3: Criar GIN index no search_vector
# ------------------------------------------
echo ""
echo "[STEP 3] Criando GIN index em search_vector..."
echo "  (pode levar 5-10 minutos...)"

start_time=$(date +%s)
psql -c "SET SESSION ROLE postgres;" -c "SET statement_timeout = '0';" \
  -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_empresas_search_vector ON dim_empresas USING gin(search_vector);" 2>&1
end_time=$(date +%s)
echo "  Index criado em $((end_time - start_time))s"

# ------------------------------------------
# STEP 4: Funcao RPC para FTS
# ------------------------------------------
echo ""
echo "[STEP 4] Criando funcao fts_empresas..."

psql -c "SET SESSION ROLE postgres; SET statement_timeout = '0';
CREATE OR REPLACE FUNCTION fts_empresas(
    p_query TEXT,
    p_cidade TEXT DEFAULT NULL,
    p_estado TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    cnpj VARCHAR,
    razao_social VARCHAR,
    nome_fantasia VARCHAR,
    cidade VARCHAR,
    estado VARCHAR,
    situacao_cadastral VARCHAR,
    rank REAL
)
LANGUAGE sql STABLE
AS \$\$
    SELECT e.id, e.cnpj, e.razao_social, e.nome_fantasia,
           e.cidade, e.estado, e.situacao_cadastral,
           ts_rank(e.search_vector, plainto_tsquery('portuguese', p_query)) AS rank
    FROM dim_empresas e
    WHERE e.search_vector @@ plainto_tsquery('portuguese', p_query)
    AND (p_cidade IS NULL OR e.cidade ILIKE '%' || p_cidade || '%')
    AND (p_estado IS NULL OR e.estado = UPPER(p_estado))
    ORDER BY rank DESC
    LIMIT p_limit;
\$\$;
" 2>&1

echo "  Funcao criada."

# ------------------------------------------
# STEP 5: ANALYZE
# ------------------------------------------
echo ""
echo "[STEP 5] ANALYZE..."
psql -c "SET SESSION ROLE postgres; SET statement_timeout = '0'; ANALYZE dim_empresas;" 2>&1

# ------------------------------------------
# STEP 6: Teste
# ------------------------------------------
echo ""
echo "[STEP 6] Teste FTS..."
psql -c "SET SESSION ROLE postgres;
SELECT id, cnpj, razao_social, rank FROM fts_empresas('petrobras energia', NULL, NULL, 5);" 2>&1

echo ""
echo "=========================================="
echo "BACKFILL COMPLETO - $(date)"
echo "=========================================="
