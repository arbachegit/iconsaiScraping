#!/usr/bin/env python3
"""
ETL Notícias → Empresas
Popula fato_noticias_empresas vinculando dim_noticias a dim_empresas.

Estratégia:
  1. Busca noticias com segmento empresarial (socio-empresa, mencao-empresarial, etc.)
  2. Extrai CNPJs do titulo, resumo, conteudo e URL
  3. Busca empresa_id correspondente em dim_empresas
  4. Insere o vínculo em fato_noticias_empresas

Tabela destino: fato_noticias_empresas
  UNIQUE(noticia_id, empresa_id)
"""

import os
import re
import sys
import time

import requests
from dotenv import load_dotenv

# .env do iconsai-scraping
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env")
if os.path.exists(ENV_PATH):
    load_dotenv(ENV_PATH)
else:
    load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERRO: SUPABASE_URL e SUPABASE_SERVICE_KEY não definidos")
    sys.exit(1)

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

# Segmentos com provável referência a empresas
SEGMENTOS_EMPRESA = [
    "socio-empresa",
    "mencao-empresarial",
    "mencao-licitacao",
]

# Mapeamento segmento → tipo_relacao
SEGMENTO_RELACAO = {
    "socio-empresa": "protagonista",
    "mencao-empresarial": "mencao",
    "mencao-licitacao": "mencao",
}


def extract_cnpjs(text: str) -> list[str]:
    """Extrai CNPJs de um texto (formatos diversos)."""
    if not text:
        return []

    cnpjs = set()

    # Formato: XX.XXX.XXX/XXXX-XX
    for m in re.finditer(r"(\d{2})\.(\d{3})\.(\d{3})/(\d{4})-?(\d{2})", text):
        cnpj = m.group(1) + m.group(2) + m.group(3) + m.group(4) + m.group(5)
        cnpjs.add(cnpj)

    # Formato: XX.XXX.XXX/XXX (parcial, sem dígitos verificadores)
    for m in re.finditer(r"(\d{2})\.(\d{3})\.(\d{3})/(\d{3,4})", text):
        partial = m.group(1) + m.group(2) + m.group(3) + m.group(4)
        if len(partial) >= 13:
            cnpjs.add(partial[:14])

    # Formato na URL: 14 dígitos seguidos
    for m in re.finditer(r"(?<!\d)(\d{14})(?!\d)", text):
        cnpj = m.group(1)
        # Filtrar números que claramente não são CNPJ
        if cnpj[:2] != "00" and int(cnpj) > 0:
            cnpjs.add(cnpj)

    return list(cnpjs)


def fetch_noticias_empresa() -> list[dict]:
    """Busca noticias com segmentos empresariais."""
    all_rows = []
    for seg in SEGMENTOS_EMPRESA:
        offset = 0
        while True:
            r = requests.get(
                f"{SUPABASE_URL}/rest/v1/dim_noticias",
                headers=HEADERS,
                params={
                    "select": "id,titulo,segmento,resumo,conteudo,url",
                    "segmento": f"eq.{seg}",
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
            all_rows.extend(rows)
            offset += 1000
            if len(rows) < 1000:
                break
    return all_rows


def lookup_empresa_cnpj(cnpj: str) -> dict | None:
    """Busca empresa por CNPJ (indexado, rápido)."""
    for _attempt in range(2):
        try:
            r = requests.get(
                f"{SUPABASE_URL}/rest/v1/dim_empresas",
                headers=HEADERS,
                params={"select": "id,razao_social", "cnpj": f"eq.{cnpj}", "limit": 1},
                timeout=30,
            )
            if r.status_code == 200:
                data = r.json()
                if data:
                    return data[0]
                return None
        except requests.exceptions.RequestException:
            time.sleep(2)
    return None


def count_existing() -> int:
    """Conta registros existentes."""
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/fato_noticias_empresas?select=id&limit=0",
        headers={**HEADERS, "Prefer": "count=exact"},
        timeout=15,
    )
    if r.status_code in (200, 206):
        return int(r.headers.get("content-range", "*/0").split("/")[-1])
    return 0


def get_existing_pairs() -> set[tuple[str, str]]:
    """Busca pares (noticia_id, empresa_id) já existentes."""
    pairs = set()
    offset = 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/fato_noticias_empresas",
            headers=HEADERS,
            params={"select": "noticia_id,empresa_id", "limit": 1000, "offset": offset},
            timeout=30,
        )
        if r.status_code != 200:
            break
        rows = r.json()
        if not rows:
            break
        for row in rows:
            pairs.add((row["noticia_id"], row["empresa_id"]))
        offset += 1000
        if len(rows) < 1000:
            break
    return pairs


def insert_batch(records: list[dict]) -> int:
    """Insere batch com retry."""
    url = (
        f"{SUPABASE_URL}/rest/v1/fato_noticias_empresas"
        f"?on_conflict=noticia_id,empresa_id"
    )
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
            if r.status_code == 409:
                # Try without on_conflict (unique constraint handles it)
                r2 = requests.post(
                    f"{SUPABASE_URL}/rest/v1/fato_noticias_empresas",
                    headers={**HEADERS, "Prefer": "return=headers-only"},
                    json=records,
                    timeout=60,
                )
                if r2.status_code in (200, 201):
                    return len(records)
            print(f"    Erro: {r.status_code} {r.text[:200]} (tentativa {attempt + 1})")
        except requests.exceptions.RequestException as e:
            print(f"    Timeout: {e} (tentativa {attempt + 1})")
        time.sleep(3 * (attempt + 1))
    return 0


def main():
    print("=" * 50)
    print("  ETL NOTÍCIAS → EMPRESAS")
    print("  Vincula dim_noticias ↔ dim_empresas")
    print("=" * 50)

    # Check existing
    existing = count_existing()
    print(f"\n  fato_noticias_empresas existentes: {existing}")

    existing_pairs = set()
    if existing > 0:
        print("  Buscando pares já processados...")
        existing_pairs = get_existing_pairs()
        print(f"  Pares existentes: {len(existing_pairs)}")

    # Fetch noticias with empresa references
    print("\n  Buscando notícias empresariais...")
    noticias = fetch_noticias_empresa()
    print(f"  Total: {len(noticias)} notícias")

    # Cache de CNPJs já buscados
    cnpj_cache: dict[str, dict | None] = {}

    # Process each noticia - CNPJ-only matching
    # (nome-based ilike queries timeout on the large dim_empresas table)
    records = []
    matched = 0
    no_cnpj = 0
    no_match = 0

    for i, n in enumerate(noticias):
        text = f"{n.get('titulo', '')} {n.get('resumo', '')} {n.get('conteudo', '')} {n.get('url', '')}"
        cnpjs = extract_cnpjs(text)

        if not cnpjs:
            no_cnpj += 1
            continue

        for cnpj in cnpjs:
            if cnpj in cnpj_cache:
                empresa = cnpj_cache[cnpj]
            else:
                empresa = lookup_empresa_cnpj(cnpj)
                cnpj_cache[cnpj] = empresa
                time.sleep(0.05)

            if empresa:
                pair = (n["id"], empresa["id"])
                if pair not in existing_pairs:
                    records.append({
                        "noticia_id": n["id"],
                        "empresa_id": empresa["id"],
                        "tipo_relacao": SEGMENTO_RELACAO.get(n.get("segmento"), "mencao"),
                        "relevancia": 8,
                        "contexto": (n.get("resumo", "") or "")[:300] or None,
                        "sentimento_empresa": "neutro",
                    })
                    existing_pairs.add(pair)
                    matched += 1
            else:
                no_match += 1

        if (i + 1) % 500 == 0:
            print(f"    Processadas: {i + 1}/{len(noticias)} (matched: {matched})")

    print("\n  Resultado matching (CNPJ-only):")
    print(f"    Matched: {matched}")
    print(f"    Sem CNPJ no texto: {no_cnpj}")
    print(f"    CNPJ não encontrado em dim_empresas: {no_match}")
    print(f"    Cache CNPJs: {len(cnpj_cache)} (encontrados: {sum(1 for v in cnpj_cache.values() if v)})")

    if not records:
        print("\n  Nenhum novo vínculo a inserir.")
        return

    print(f"\n  Registros a inserir: {len(records)}")

    # Insert in batches
    batch_size = 200
    inserted = 0
    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        n = insert_batch(batch)
        inserted += n
        if n > 0:
            print(f"    Batch {i // batch_size + 1}: {n} ok")
        time.sleep(0.3)

    print(f"\n  Inseridos: {inserted}")

    # Verify
    final = count_existing()
    print(f"  fato_noticias_empresas final: {final}")
    print("=" * 50)
    print("ETL concluído!")


if __name__ == "__main__":
    main()
