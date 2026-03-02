#!/usr/bin/env python3
"""
ETL Finanças Municipais - Completa financas_municipios com dados SICONFI.

Fonte: Tesouro Nacional / SICONFI - DCA (Declaração de Contas Anuais)
  - Anexo I-C: Receitas
  - Anexo I-D: Despesas

Ações:
  1. Adiciona 2024 (novo ano disponível)
  2. Preenche municípios faltantes em 2014-2023

Banco: Brasil Data Hub (Supabase)
Tabela: financas_municipios (UNIQUE(codigo_ibge, ano))
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from dotenv import load_dotenv

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "brasil-data-hub-etl", ".env")
if os.path.exists(ENV_PATH):
    load_dotenv(ENV_PATH)
else:
    load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERRO: SUPABASE_URL e SUPABASE_KEY não definidos")
    sys.exit(1)

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

SICONFI_BASE = "https://apidatalake.tesouro.gov.br/ords/siconfi/tt"

# Contas-chave: receitas
RECEITA_KEYS = {
    # 2018+ format
    "TotalReceitas": "receita_total",
    "RO1.0.0.0.00.0.0": "receita_corrente",
    "RO2.0.0.0.00.0.0": "receita_capital",
    "RO1.7.0.0.00.0.0": "transferencias_correntes",
    # 2014-2017 legacy format
    "RO1.0.0.0.00.00.00": "receita_corrente",
    "RO2.0.0.0.00.00.00": "receita_capital",
    "RO1.7.0.0.00.00.00": "transferencias_correntes",
}

# Contas-chave: despesas
DESPESA_KEYS = {
    "TotalDespesas": "despesa_total",
    "DO3.0.00.00.00.00": "despesa_corrente",
    "DO3.1.00.00.00.00": "despesa_pessoal",
    "DO4.0.00.00.00.00": "despesa_capital",
    "DO4.4.00.00.00.00": "investimentos",
}


def fetch_dca(id_ente: int, ano: int, anexo: str) -> list:
    """Fetch DCA com retry."""
    url = f"{SICONFI_BASE}/dca?an_exercicio={ano}&no_anexo={anexo}&id_ente={id_ente}"
    for _attempt in range(2):
        try:
            resp = requests.get(url, timeout=30)
            if resp.status_code == 200:
                return resp.json().get("items", [])
        except requests.exceptions.RequestException:
            pass
        time.sleep(1)
    return []


def extract_financas(id_ente: int, ano: int) -> dict:
    """Extrai dados financeiros de um município/ano."""
    dados = {"codigo_ibge": id_ente}

    # Receitas (Anexo I-C)
    items = fetch_dca(id_ente, ano, "DCA-Anexo%20I-C")
    for r in items:
        cod = r.get("cod_conta", "")
        coluna = r.get("coluna", "")
        valor = r.get("valor")
        if "Brut" in coluna and cod in RECEITA_KEYS and valor:
            campo = RECEITA_KEYS[cod]
            # Não sobrescrever se já tiver (TotalReceitas > conta específica)
            if campo not in dados or campo == "receita_total":
                dados[campo] = valor

    # Se não encontrou TotalReceitas, usar ReceitasExcetoIntraOrcamentarias
    if "receita_total" not in dados:
        for r in items:
            cod = r.get("cod_conta", "")
            coluna = r.get("coluna", "")
            valor = r.get("valor")
            if cod == "ReceitasExcetoIntraOrcamentarias" and "Brut" in coluna and valor:
                dados["receita_total"] = valor
                break

    # Despesas (Anexo I-D)
    items = fetch_dca(id_ente, ano, "DCA-Anexo%20I-D")
    for r in items:
        cod = r.get("cod_conta", "")
        coluna = r.get("coluna", "")
        valor = r.get("valor")
        if "Empenha" in coluna and cod in DESPESA_KEYS and valor:
            dados[DESPESA_KEYS[cod]] = valor

    return dados


def get_entes_municipais() -> list[int]:
    """Lista códigos IBGE dos entes municipais."""
    url = f"{SICONFI_BASE}/entes?an_referencia=2024&in_tipo_ente=M"
    try:
        resp = requests.get(url, timeout=60)
        if resp.status_code == 200:
            return [e["cod_ibge"] for e in resp.json().get("items", [])]
    except requests.exceptions.RequestException:
        pass
    return []


def get_existing_codigos(ano: int) -> set[int]:
    """Busca códigos IBGE já presentes no banco para um ano."""
    codigos = set()
    offset = 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/financas_municipios",
            headers=HEADERS,
            params={
                "select": "codigo_ibge",
                "ano": f"eq.{ano}",
                "limit": 1000,
                "offset": offset,
            },
            timeout=30,
        )
        if r.status_code != 200:
            break
        rows = r.json()
        if not rows:
            break
        for row in rows:
            codigos.add(row["codigo_ibge"])
        offset += 1000
        if len(rows) < 1000:
            break
    return codigos


def count_records(ano: int) -> int:
    """Conta registros de um ano."""
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/financas_municipios?ano=eq.{ano}&select=id&limit=0",
        headers={**HEADERS, "Prefer": "count=exact"},
        timeout=15,
    )
    if r.status_code in (200, 206):
        return int(r.headers.get("content-range", "*/0").split("/")[-1])
    return 0


def upsert_batch(records: list[dict]) -> int:
    """Upsert via PostgREST."""
    url = f"{SUPABASE_URL}/rest/v1/financas_municipios?on_conflict=codigo_ibge,ano"
    for attempt in range(3):
        try:
            r = requests.post(
                url,
                headers={**HEADERS, "Prefer": "resolution=merge-duplicates,return=headers-only"},
                json=records,
                timeout=60,
            )
            if r.status_code in (200, 201):
                return len(records)
            print(f"    Erro upsert: {r.status_code} {r.text[:200]} (tentativa {attempt + 1})")
        except requests.exceptions.RequestException as e:
            print(f"    Timeout: {e} (tentativa {attempt + 1})")
        time.sleep(3 * (attempt + 1))
    return 0


def process_year(ano: int, all_entes: list[int]) -> int:
    """Processa um ano: busca SICONFI e insere dados faltantes."""
    print(f"\n{'=' * 50}")
    print(f"  ANO {ano}")
    print(f"{'=' * 50}")

    existing = get_existing_codigos(ano)
    print(f"  Existentes: {len(existing)}")

    # Municípios faltantes
    missing = [e for e in all_entes if e not in existing]
    if not missing:
        print(f"  Todos os {len(all_entes)} municípios já preenchidos.")
        return 0

    print(f"  Faltantes: {len(missing)} municípios")
    print(f"  Buscando SICONFI DCA para {len(missing)} municípios (8 threads)...")

    resultados = []
    errors = 0

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(extract_financas, eid, ano): eid
            for eid in missing
        }
        for done, future in enumerate(as_completed(futures), 1):
            if done % 500 == 0:
                print(f"    {done}/{len(missing)} processados...")
            try:
                dados = future.result()
                if dados.get("receita_total") or dados.get("despesa_total"):
                    resultados.append(dados)
            except Exception:
                errors += 1

    print(f"  -> {len(resultados)} com dados, {errors} erros, {len(missing) - len(resultados) - errors} sem DCA")

    if not resultados:
        return 0

    # Montar registros
    registros = []
    for dados in resultados:
        cod = dados["codigo_ibge"]
        rec_total = dados.get("receita_total")
        desp_total = dados.get("despesa_total")
        resultado_orc = round(rec_total - desp_total, 2) if rec_total and desp_total else None

        registros.append({
            "codigo_ibge": cod,
            "codigo_ibge_uf": int(str(cod)[:2]),
            "ano": ano,
            "receita_total": rec_total,
            "receita_corrente": dados.get("receita_corrente"),
            "receita_capital": dados.get("receita_capital"),
            "transferencias_correntes": dados.get("transferencias_correntes"),
            "despesa_total": desp_total,
            "despesa_corrente": dados.get("despesa_corrente"),
            "despesa_pessoal": dados.get("despesa_pessoal"),
            "despesa_capital": dados.get("despesa_capital"),
            "investimentos": dados.get("investimentos"),
            "resultado_orcamentario": resultado_orc,
            "fonte": "Tesouro/SICONFI-DCA",
        })

    print(f"  Inserindo {len(registros)} registros...")
    batch_size = 500
    inserted = 0
    for i in range(0, len(registros), batch_size):
        batch = registros[i : i + batch_size]
        n = upsert_batch(batch)
        inserted += n
        time.sleep(0.3)

    print(f"  Inseridos: {inserted}")
    return inserted


def main():
    print("=" * 50)
    print("  ETL FINANÇAS MUNICIPAIS")
    print("  Fonte: Tesouro/SICONFI DCA")
    print("=" * 50)

    # Lista de entes municipais
    print("\n  Buscando lista de entes municipais...")
    all_entes = get_entes_municipais()
    if not all_entes:
        print("  Erro: não conseguiu lista de entes")
        return
    print(f"  {len(all_entes)} municípios")

    # Processar todos os anos (2014-2024)
    total = 0
    for ano in range(2014, 2025):
        n = process_year(ano, all_entes)
        total += n

    # Resumo
    print(f"\n{'=' * 50}")
    print("  RESUMO FINAL - financas_municipios")
    print(f"{'=' * 50}")
    grand_total = 0
    for ano in range(2014, 2025):
        c = count_records(ano)
        grand_total += c
        if c > 0:
            print(f"  {ano}: {c:>6} municípios")
    print(f"  {'─' * 30}")
    print(f"  TOTAL: {grand_total:>6} registros")
    print(f"  Novos: {total:>6}")
    print(f"{'=' * 50}")
    print("ETL concluído!")


if __name__ == "__main__":
    main()
