-- =============================================
-- DIAGNOSTICO COMPLETO: dim_empresas (64M+)
-- Executar no Supabase SQL Editor
-- Cole os resultados para analise
-- =============================================

-- 1) ESTRUTURA DA TABELA (colunas e tipos)
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'dim_empresas'
ORDER BY ordinal_position;

-- 2) INDICES EXISTENTES
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'dim_empresas'
ORDER BY indexname;

-- 3) TAMANHO DA TABELA
SELECT
    pg_size_pretty(pg_total_relation_size('dim_empresas')) AS total_size,
    pg_size_pretty(pg_relation_size('dim_empresas')) AS table_size,
    pg_size_pretty(pg_total_relation_size('dim_empresas') - pg_relation_size('dim_empresas')) AS index_size;

-- 4) ESTATISTICAS DE USO
SELECT
    relname,
    seq_scan,
    idx_scan,
    n_tup_ins,
    n_tup_upd,
    n_tup_del,
    n_live_tup,
    n_dead_tup
FROM pg_stat_user_tables
WHERE relname = 'dim_empresas';

-- 5) AUTOVACUUM
SELECT
    relname,
    last_vacuum,
    last_autovacuum,
    vacuum_count,
    autovacuum_count
FROM pg_stat_user_tables
WHERE relname = 'dim_empresas';

-- 6) CONTAGEM ESTIMADA (sem full scan)
SELECT reltuples::bigint AS estimated_rows
FROM pg_class
WHERE relname = 'dim_empresas';

-- 7) RLS STATUS
SELECT
    tablename,
    rowsecurity
FROM pg_tables
WHERE tablename = 'dim_empresas';

-- 8) FOREIGN KEYS referenciando dim_empresas
SELECT
    tc.constraint_name,
    tc.table_name AS child_table,
    kcu.column_name AS child_column,
    ccu.table_name AS parent_table,
    ccu.column_name AS parent_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
    AND (ccu.table_name = 'dim_empresas' OR tc.table_name = 'dim_empresas');

-- 9) QUERIES MAIS PESADAS (se pg_stat_statements habilitado)
SELECT
    LEFT(query, 200) AS query_preview,
    calls,
    ROUND(total_exec_time::numeric, 2) AS total_ms,
    ROUND(mean_exec_time::numeric, 2) AS mean_ms,
    rows
FROM pg_stat_statements
WHERE query ILIKE '%dim_empresas%'
ORDER BY total_exec_time DESC
LIMIT 10;

-- 10) BLOAT ESTIMATE (dead tuples ratio)
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    CASE WHEN n_live_tup > 0
        THEN ROUND(100.0 * n_dead_tup / n_live_tup, 2)
        ELSE 0
    END AS dead_pct
FROM pg_stat_user_tables
WHERE relname = 'dim_empresas';
