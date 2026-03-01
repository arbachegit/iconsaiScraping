#!/usr/bin/env python3
"""
ETL Emprego Municipal - Preenche emprego_municipios com dados reais.

Fontes:
  1. IBGE/CEMPRE (Cadastro Central de Empresas)
     - 2010-2021: SIDRA tabela 1685 (já carregado)
     - 2022-2023: IBGE Cidades API (nova série, versão 1145)
  2. Projeções econométricas mantidas para anos sem dados reais.

Indicadores IBGE Cidades (período 2022+):
  143491 → unidades_locais
  143513 → empresas
  143514 → pessoal_ocupado_total
  143536 → pessoal_assalariado
  143558 → salario_medio_sm
  143580 → salarios_mil_reais

Banco: Supabase (Brasil Data Hub)
Tabela: emprego_municipios (UNIQUE(codigo_ibge, ano))
"""

import os
import sys
import time
import json
import requests
from typing import Optional
from dotenv import load_dotenv

# Carregar .env do diretório brasil-data-hub-etl
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "brasil-data-hub-etl", ".env")
if os.path.exists(ENV_PATH):
    load_dotenv(ENV_PATH)
else:
    load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERRO: SUPABASE_URL e SUPABASE_KEY devem estar definidos no .env")
    sys.exit(1)

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=headers-only",
}

# ─── IBGE Cidades API ───────────────────────────────────────

IBGE_CIDADES_BASE = "https://servicodados.ibge.gov.br/api/v1"
IBGE_MUNIS_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/{uf}/municipios"

# Indicadores CEMPRE nova série (versão 1145, 2022+)
INDICATOR_MAP = {
    143491: "unidades_locais",
    143513: "empresas",
    143514: "pessoal_ocupado_total",
    143536: "pessoal_assalariado",
    143558: "salario_medio_sm",
    143580: "salarios_mil_reais",
}

INDICATOR_IDS = "|".join(str(k) for k in INDICATOR_MAP)

# Salário mínimo por ano (para calcular salario_medio_reais)
SALARIO_MINIMO = {
    2022: 1212.00,
    2023: 1320.00,
    2024: 1412.00,
    2025: 1518.00,
}

UF_CODES = [
    11, 12, 13, 14, 15, 16, 17,  # Norte
    21, 22, 23, 24, 25, 26, 27, 28, 29,  # Nordeste
    31, 32, 33, 35,  # Sudeste
    41, 42, 43,  # Sul
    50, 51, 52, 53,  # Centro-Oeste
]


def fetch_json(url: str, timeout: int = 30, retries: int = 3) -> Optional[list | dict]:
    """GET com retry."""
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=timeout)
            if resp.status_code == 200:
                return resp.json()
            print(f"    HTTP {resp.status_code} (tentativa {attempt + 1})")
        except requests.exceptions.RequestException as e:
            print(f"    Erro: {e} (tentativa {attempt + 1})")
        time.sleep(2 * (attempt + 1))
    return None


def get_municipios_uf(uf: int) -> list[dict]:
    """Retorna lista de municípios de uma UF com código IBGE 6 e 7 dígitos."""
    url = IBGE_MUNIS_URL.format(uf=uf)
    data = fetch_json(url)
    if not data:
        return []
    result = []
    for m in data:
        code7 = str(m["id"])  # 7 dígitos
        code6 = code7[:6]  # 6 dígitos (usado na API Cidades)
        result.append({"code6": code6, "code7": int(code7), "nome": m["nome"]})
    return result


def fetch_cempre_uf(uf: int, ano: int) -> dict:
    """
    Busca dados CEMPRE de todos os municípios de uma UF via IBGE Cidades API.
    Retorna dict {codigo_ibge_7: {campo: valor, ...}}.
    """
    munis = get_municipios_uf(uf)
    if not munis:
        print(f"    Nenhum município encontrado para UF {uf}")
        return {}

    # Mapear code6 → code7
    code_map = {m["code6"]: m["code7"] for m in munis}

    # Montar URL com todos os municípios da UF
    muni_codes = "|".join(m["code6"] for m in munis)
    url = (
        f"{IBGE_CIDADES_BASE}/pesquisas/19/periodos/{ano}"
        f"/indicadores/{INDICATOR_IDS}/resultados/{muni_codes}"
    )

    data = fetch_json(url, timeout=60)
    if not data or not isinstance(data, list):
        return {}

    # Parsear resultados
    municipios: dict[int, dict] = {}
    for indicator in data:
        ind_id = indicator.get("id")
        campo = INDICATOR_MAP.get(ind_id)
        if not campo:
            continue

        for result in indicator.get("res", []):
            code6 = result.get("localidade", "")
            code7 = code_map.get(code6)
            if not code7:
                continue

            val_str = result.get("res", {}).get(str(ano))
            if not val_str or val_str in ("-", "...", "..", "X", ""):
                continue

            if code7 not in municipios:
                municipios[code7] = {"codigo_ibge": code7}

            try:
                if campo in ("salario_medio_sm",):
                    municipios[code7][campo] = float(val_str)
                elif campo == "salarios_mil_reais":
                    municipios[code7][campo] = int(float(val_str))
                else:
                    municipios[code7][campo] = int(float(val_str))
            except (ValueError, TypeError):
                pass

    return municipios


def delete_projected_data(ano: int) -> int:
    """Remove dados projetados de um ano específico."""
    url = (
        f"{SUPABASE_URL}/rest/v1/emprego_municipios"
        f"?ano=eq.{ano}&fonte=eq.Projeção econométrica"
    )
    resp = requests.delete(url, headers={**HEADERS, "Prefer": "return=headers-only,count=exact"})
    if resp.status_code in (200, 204):
        count = resp.headers.get("content-range", "*/0").split("/")[-1]
        return int(count) if count != "*" else 0
    print(f"    Erro ao deletar projeções {ano}: {resp.status_code} {resp.text[:200]}")
    return 0


def count_records(ano: int, fonte: Optional[str] = None) -> int:
    """Conta registros de um ano (opcionalmente filtrados por fonte)."""
    url = f"{SUPABASE_URL}/rest/v1/emprego_municipios?ano=eq.{ano}&select=id"
    if fonte:
        url += f"&fonte=eq.{fonte}"
    resp = requests.get(
        url,
        headers={**HEADERS, "Prefer": "count=exact"},
        params={"limit": 1},
    )
    if resp.status_code in (200, 206):
        cr = resp.headers.get("content-range", "*/0")
        total = cr.split("/")[-1]
        return int(total) if total != "*" else 0
    return 0


def upsert_batch(records: list[dict]) -> int:
    """Upsert batch via PostgREST com on_conflict na URL."""
    url = (
        f"{SUPABASE_URL}/rest/v1/emprego_municipios"
        f"?on_conflict=codigo_ibge,ano"
    )
    resp = requests.post(
        url,
        headers={**HEADERS, "Prefer": "resolution=merge-duplicates,return=headers-only"},
        json=records,
    )
    if resp.status_code in (200, 201):
        return len(records)
    print(f"    Erro upsert: {resp.status_code} {resp.text[:300]}")
    return 0


def process_year(ano: int) -> int:
    """Processa um ano completo: busca CEMPRE e insere/atualiza."""
    print(f"\n{'=' * 50}")
    print(f"  ANO {ano}")
    print(f"{'=' * 50}")

    # Verificar dados existentes
    total_existing = count_records(ano)
    projected = count_records(ano, "Projeção econométrica")
    real = count_records(ano, "IBGE/CEMPRE")

    print(f"  Existentes: {total_existing} ({real} CEMPRE, {projected} projeções)")

    if real > 0 and projected == 0:
        print(f"  Já tem dados reais CEMPRE, pulando.")
        return 0

    # Buscar dados CEMPRE
    print(f"  Buscando CEMPRE {ano} via IBGE Cidades API (27 UFs)...")
    all_munis: dict = {}

    for i, uf in enumerate(UF_CODES, 1):
        munis = fetch_cempre_uf(uf, ano)
        all_munis.update(munis)
        print(f"    UF {uf:02d}: {len(munis)} municípios ({i}/{len(UF_CODES)})")
        time.sleep(0.5)  # Rate limiting

    print(f"  Total: {len(all_munis)} municípios com dados")

    if not all_munis:
        print(f"  Nenhum dado encontrado para {ano}")
        return 0

    # Montar registros
    sm = SALARIO_MINIMO.get(ano, 1320.0)  # fallback
    records = []
    for code7, dados in all_munis.items():
        if not dados.get("pessoal_ocupado_total"):
            continue

        salario_sm = dados.get("salario_medio_sm")
        salario_reais = round(salario_sm * sm, 2) if salario_sm else None

        records.append({
            "codigo_ibge": int(code7),
            "codigo_ibge_uf": int(str(code7)[:2]),
            "ano": ano,
            "unidades_locais": dados.get("unidades_locais"),
            "empresas": dados.get("empresas"),
            "pessoal_ocupado_total": dados.get("pessoal_ocupado_total"),
            "pessoal_assalariado": dados.get("pessoal_assalariado"),
            "salarios_mil_reais": dados.get("salarios_mil_reais"),
            "salario_medio_sm": salario_sm,
            "salario_medio_reais": salario_reais,
            "fonte": "IBGE/CEMPRE",
        })

    print(f"  Registros válidos: {len(records)}")

    if projected > 0:
        print(f"  Removendo {projected} projeções para {ano}...")
        deleted = delete_projected_data(ano)
        print(f"  Removidos: {deleted}")

    # Inserir em batches
    print(f"  Inserindo {len(records)} registros...")
    batch_size = 500
    inserted = 0
    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        n = upsert_batch(batch)
        inserted += n
        if n > 0:
            print(f"    Batch {i // batch_size + 1}: {n} ok")
        time.sleep(0.3)

    print(f"  Inseridos: {inserted} de {len(records)}")
    return inserted


def show_summary():
    """Mostra resumo final da tabela."""
    print(f"\n{'=' * 50}")
    print("  RESUMO FINAL - emprego_municipios")
    print(f"{'=' * 50}")

    total = 0
    for ano in range(2010, 2026):
        real = count_records(ano, "IBGE/CEMPRE")
        proj = count_records(ano, "Projeção econométrica")
        t = real + proj
        total += t
        if t > 0:
            fonte = "CEMPRE" if real > 0 else "Projeção"
            print(f"  {ano}: {t:>6} municípios  [{fonte}]")

    print(f"  {'─' * 36}")
    print(f"  TOTAL: {total:>6} registros")
    print(f"{'=' * 50}")


def main():
    print("=" * 50)
    print("  ETL EMPREGO MUNICIPAL")
    print("  Fonte: IBGE/CEMPRE (Cadastro Central de Empresas)")
    print("=" * 50)

    # Anos com dados CEMPRE disponíveis na nova série (2022+)
    anos_novos = [2022, 2023]

    total_inserted = 0
    for ano in anos_novos:
        n = process_year(ano)
        total_inserted += n

    print(f"\nTotal inserido/atualizado: {total_inserted}")

    show_summary()
    print("\nETL concluído!")


if __name__ == "__main__":
    main()
