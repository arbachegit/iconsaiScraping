-- Migration: Search Trigram Indexes
-- Date: 2026-02-26
-- Purpose: Enable fast ILIKE search on dim_empresas (60M+ rows)
--
-- Problem: ILIKE '%term%' queries on razao_social/nome_fantasia
-- do full table scans on 60M rows → timeout
--
-- Solution: pg_trgm GIN indexes enable fast trigram-based matching

-- 1. Enable pg_trgm extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Trigram index on razao_social (main company name)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dim_empresas_razao_social_trgm
  ON dim_empresas USING gin (razao_social gin_trgm_ops);

-- 3. Trigram index on nome_fantasia (trade name)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dim_empresas_nome_fantasia_trgm
  ON dim_empresas USING gin (nome_fantasia gin_trgm_ops);
