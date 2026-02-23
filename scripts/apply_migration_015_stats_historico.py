#!/usr/bin/env python3
"""
Apply migration 015: Create stats_historico table for dashboard badges.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

MIGRATION_SQL = """
-- Migration: 015_stats_historico.sql
-- Descricao: Tabela para historico de estatisticas do dashboard

-- Criar tabela stats_historico (se nao existir)
CREATE TABLE IF NOT EXISTS stats_historico (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data DATE NOT NULL,
    categoria TEXT NOT NULL CHECK (categoria IN ('empresas', 'pessoas', 'politicos', 'noticias')),
    total INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(data, categoria)
);

-- Comentarios
COMMENT ON TABLE stats_historico IS 'Historico diario de contagens para dashboard badges';
COMMENT ON COLUMN stats_historico.data IS 'Data do snapshot (YYYY-MM-DD)';
COMMENT ON COLUMN stats_historico.categoria IS 'Categoria: empresas, pessoas, politicos, noticias';
COMMENT ON COLUMN stats_historico.total IS 'Total acumulado na data';

-- Indices para performance
CREATE INDEX IF NOT EXISTS idx_stats_historico_data ON stats_historico(data);
CREATE INDEX IF NOT EXISTS idx_stats_historico_categoria ON stats_historico(categoria);
CREATE INDEX IF NOT EXISTS idx_stats_historico_data_categoria ON stats_historico(data, categoria);
"""


def main():
    print("=" * 60)
    print("MIGRATION 015: Create stats_historico table")
    print("=" * 60)

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")

    if not supabase_url or not supabase_key:
        print("ERRO: SUPABASE_URL e SUPABASE_SERVICE_KEY sao obrigatorios")
        sys.exit(1)

    supabase = create_client(supabase_url, supabase_key)

    # Test if table exists
    print("\n[1/3] Verificando se tabela existe...")
    table_exists = False
    try:
        result = supabase.table("stats_historico").select("id").limit(1).execute()
        print("    ✓ Tabela stats_historico ja existe")
        table_exists = True
    except Exception as e:
        if "relation" in str(e).lower() and "does not exist" in str(e).lower():
            print("    ⚠ Tabela nao existe - sera criada")
        else:
            print(f"    Erro ao verificar: {e}")

    if not table_exists:
        print("\n[2/3] Criando tabela...")
        print("\n" + "=" * 60)
        print("ACAO MANUAL NECESSARIA")
        print("=" * 60)
        print("\nExecute este SQL no Supabase Studio (SQL Editor):\n")
        print(MIGRATION_SQL)
        print("\n" + "=" * 60)
        print("URL do Supabase Studio:")
        print(f"  {supabase_url.replace('.supabase.co', '.supabase.co/project/default/sql')}")
        print("=" * 60)
        return

    # Populate initial data
    print("\n[3/3] Populando dados iniciais...")
    try:
        from datetime import date

        hoje = date.today()

        # Get current counts
        empresas = supabase.table("dim_empresas").select("id", count="exact", head=True).execute()
        pessoas = supabase.table("fato_pessoas").select("id", count="exact", head=True).execute()
        noticias = supabase.table("fato_noticias").select("id", count="exact", head=True).execute()

        # Check brasil-data-hub for politicos
        brasil_hub_url = os.getenv("BRASIL_DATA_HUB_URL")
        brasil_hub_key = os.getenv("BRASIL_DATA_HUB_KEY")
        politicos_count = 0

        if brasil_hub_url and brasil_hub_key:
            brasil_hub = create_client(brasil_hub_url, brasil_hub_key)
            try:
                politicos = brasil_hub.table("dim_politicos").select("id", count="exact", head=True).execute()
                politicos_count = politicos.count or 0
            except Exception:
                print("    ⚠ Nao foi possivel conectar ao brasil-data-hub")

        snapshots = [
            {"data": hoje.isoformat(), "categoria": "empresas", "total": empresas.count or 0},
            {"data": hoje.isoformat(), "categoria": "pessoas", "total": pessoas.count or 0},
            {"data": hoje.isoformat(), "categoria": "politicos", "total": politicos_count},
            {"data": hoje.isoformat(), "categoria": "noticias", "total": noticias.count or 0},
        ]

        for snap in snapshots:
            try:
                supabase.table("stats_historico").upsert(
                    snap, on_conflict="data,categoria"
                ).execute()
                print(f"    ✓ {snap['categoria']}: {snap['total']}")
            except Exception as e:
                print(f"    ✗ Erro em {snap['categoria']}: {e}")

        print("\n" + "=" * 60)
        print("MIGRACAO CONCLUIDA COM SUCESSO!")
        print("=" * 60)
        print(f"\nTotal de registros criados: {len(snapshots)}")
        print("Data do snapshot:", hoje.isoformat())

    except Exception as e:
        print(f"\n    ✗ Erro ao popular dados: {e}")


if __name__ == "__main__":
    main()
