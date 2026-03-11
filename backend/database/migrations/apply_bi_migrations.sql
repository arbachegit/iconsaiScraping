-- ============================================================
-- BI Pipeline Migrations (037-047)
-- Execute in order in Supabase SQL Editor
-- ============================================================

-- Run each migration file in sequence:
-- 037_fato_evidencias.sql
-- 038_dim_contextos.sql
-- 039_dim_taxonomia_empresa.sql
-- 040_fato_website_crawl.sql
-- 041_dim_ecossistema_empresas.sql
-- 042_dim_produtos.sql
-- 043_dim_contatos_website.sql
-- 044_dim_datas_comemorativas.sql
-- 045_perfis_geo_cnae_tributario.sql
-- 046_fato_oportunidades.sql
-- 047_relacoes_temporal_tracking.sql

-- Add unique constraint for upsert support on profiles
ALTER TABLE fato_perfil_cnae ADD CONSTRAINT uq_perfil_cnae_empresa UNIQUE (empresa_id);
ALTER TABLE fato_perfil_tributario ADD CONSTRAINT uq_perfil_trib_empresa UNIQUE (empresa_id);
ALTER TABLE fato_perfil_geografico ADD CONSTRAINT uq_perfil_geo_empresa UNIQUE (empresa_id);
