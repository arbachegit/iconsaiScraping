#!/usr/bin/env python3
"""
ETL Notícias → Tópicos
Popula fato_noticias_topicos a partir de dim_noticias já processadas pelo Claude.

Cada notícia gera 1 tópico baseado no segmento existente, usando:
  - segmento → topico + topico_slug
  - resumo → analise_resumo
  - relevancia_geral → relevancia (escala 1-10)
  - titulo/resumo → keywords e entidades
  - sentimento inferido do segmento

Tabela destino: fato_noticias_topicos (iconsai-scraping Supabase)
"""

import os
import re
import sys
import time
import unicodedata
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

# Mapeamento segmento → tópico legível
SEGMENTO_TOPICO = {
    "socio-empresa": "Sociedade Empresarial",
    "mencao-empresarial": "Menção Empresarial",
    "mencao-judicial": "Menção Judicial",
    "mencao-politica": "Menção Política",
    "mencao-noticia": "Menção em Notícia",
    "cargo-nomeacao": "Nomeação para Cargo",
    "mencao-academica": "Menção Acadêmica",
    "mencao-social": "Menção Social",
    "autor-artigo": "Autor de Artigo",
    "mencao-obituario": "Obituário",
    "mencao-licitacao": "Licitação",
    "mencao-esportiva": "Menção Esportiva",
    "palestrante-evento": "Palestrante em Evento",
    "mencao-premiacao": "Premiação",
    "entrevista": "Entrevista",
    "cargo-demissao": "Demissão de Cargo",
}

# Sentimento padrão por segmento
SEGMENTO_SENTIMENTO = {
    "socio-empresa": "neutro",
    "mencao-empresarial": "neutro",
    "mencao-judicial": "negativo",
    "mencao-politica": "neutro",
    "mencao-noticia": "neutro",
    "cargo-nomeacao": "positivo",
    "mencao-academica": "positivo",
    "mencao-social": "neutro",
    "autor-artigo": "positivo",
    "mencao-obituario": "negativo",
    "mencao-licitacao": "neutro",
    "mencao-esportiva": "positivo",
    "palestrante-evento": "positivo",
    "mencao-premiacao": "positivo",
    "entrevista": "neutro",
    "cargo-demissao": "negativo",
}

# Impacto no mercado por segmento
SEGMENTO_IMPACTO = {
    "socio-empresa": "medio",
    "mencao-empresarial": "medio",
    "mencao-judicial": "alto",
    "mencao-politica": "medio",
    "mencao-noticia": "baixo",
    "cargo-nomeacao": "medio",
    "mencao-academica": "baixo",
    "mencao-social": "baixo",
    "autor-artigo": "baixo",
    "mencao-obituario": "baixo",
    "mencao-licitacao": "medio",
    "mencao-esportiva": "baixo",
    "palestrante-evento": "baixo",
    "mencao-premiacao": "baixo",
    "entrevista": "medio",
    "cargo-demissao": "medio",
}

STOPWORDS = {
    "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
    "com", "por", "para", "pelo", "pela", "um", "uma", "uns", "umas",
    "ao", "aos", "à", "às", "o", "a", "os", "as", "e", "ou", "que",
    "se", "é", "são", "foi", "ser", "ter", "há", "não", "mais", "como",
    "sobre", "entre", "após", "até", "seu", "sua", "seus", "suas",
    "este", "esta", "esse", "essa", "aquele", "aquela", "ele", "ela",
}


def normalize(text: str) -> str:
    """Remove acentos e converte para minúsculo."""
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()


def extract_keywords(titulo: str, resumo: str) -> list[str]:
    """Extrai keywords relevantes do título e resumo."""
    text = f"{titulo} {resumo or ''}"
    words = re.findall(r"\b[A-ZÀ-Ü][a-zà-ü]{2,}\b", text)
    words += re.findall(r"\b[A-ZÀ-Ü]{2,}\b", text)
    clean = []
    seen = set()
    for w in words:
        wl = normalize(w)
        if wl not in STOPWORDS and wl not in seen and len(w) > 2:
            seen.add(wl)
            clean.append(w)
    return clean[:10]


def extract_entidades(titulo: str, resumo: str) -> list[str]:
    """Extrai nomes próprios (entidades) do título e resumo."""
    text = f"{titulo} {resumo or ''}"
    # Nomes com múltiplas palavras capitalizadas
    names = re.findall(
        r"\b(?:[A-ZÀ-Ü][a-zà-ü]+(?:\s+(?:de|da|do|das|dos|e)\s+)?){2,}[A-ZÀ-Ü][a-zà-ü]+\b",
        text,
    )
    # CNPJs
    cnpjs = re.findall(r"\d{2}\.\d{3}\.\d{3}/\d{3,4}-?\d{0,2}", text)
    entidades = list(dict.fromkeys(names[:5] + cnpjs[:3]))
    return entidades


def fetch_noticias() -> list[dict]:
    """Busca todas as notícias do dim_noticias."""
    all_rows = []
    offset = 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/dim_noticias",
            headers=HEADERS,
            params={
                "select": "id,titulo,segmento,resumo,relevancia_geral",
                "limit": 1000,
                "offset": offset,
            },
            timeout=30,
        )
        if r.status_code != 200:
            print(f"  Erro fetch noticias: {r.status_code}")
            break
        rows = r.json()
        if not rows:
            break
        all_rows.extend(rows)
        offset += 1000
        if len(rows) < 1000:
            break
    return all_rows


def count_topicos() -> int:
    """Conta registros em fato_noticias_topicos."""
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/fato_noticias_topicos?select=id&limit=0",
        headers={**HEADERS, "Prefer": "count=exact"},
        timeout=15,
    )
    if r.status_code in (200, 206):
        return int(r.headers.get("content-range", "*/0").split("/")[-1])
    return 0


def insert_batch(records: list[dict]) -> int:
    """Insere batch em fato_noticias_topicos com retry."""
    url = f"{SUPABASE_URL}/rest/v1/fato_noticias_topicos"
    for attempt in range(3):
        try:
            r = requests.post(
                url,
                headers={**HEADERS, "Prefer": "return=headers-only"},
                json=records,
                timeout=60,
            )
            if r.status_code in (200, 201):
                return len(records)
            print(f"    Erro insert: {r.status_code} {r.text[:200]} (tentativa {attempt + 1})")
        except requests.exceptions.RequestException as e:
            print(f"    Timeout/erro: {e} (tentativa {attempt + 1})")
        time.sleep(3 * (attempt + 1))
    return 0


def main():
    print("=" * 50)
    print("  ETL NOTÍCIAS → TÓPICOS")
    print("  Fonte: dim_noticias (já processadas)")
    print("=" * 50)

    # Check existing - get noticia_ids already processed
    existing = count_topicos()
    print(f"\n  fato_noticias_topicos existentes: {existing}")

    existing_ids = set()
    if existing > 0:
        print("  Buscando IDs já processados...")
        offset = 0
        while True:
            r = requests.get(
                f"{SUPABASE_URL}/rest/v1/fato_noticias_topicos",
                headers=HEADERS,
                params={"select": "noticia_id", "limit": 1000, "offset": offset},
                timeout=30,
            )
            if r.status_code != 200:
                break
            rows = r.json()
            if not rows:
                break
            for row in rows:
                existing_ids.add(row["noticia_id"])
            offset += 1000
            if len(rows) < 1000:
                break
        print(f"  IDs já processados: {len(existing_ids)}")

    # Fetch all noticias
    print("\n  Buscando dim_noticias...")
    noticias = fetch_noticias()
    print(f"  Total: {len(noticias)} notícias")

    if not noticias:
        print("  Nenhuma notícia encontrada")
        return

    # Build topic records (skip already processed)
    records = []
    for n in noticias:
        if n["id"] in existing_ids:
            continue

        segmento = n.get("segmento", "")
        titulo = n.get("titulo", "")
        resumo = n.get("resumo", "")
        rel_geral = n.get("relevancia_geral", 50)

        topico = SEGMENTO_TOPICO.get(segmento, segmento.replace("-", " ").title())
        relevancia = max(1, min(10, round(rel_geral / 10)))
        sentimento = SEGMENTO_SENTIMENTO.get(segmento, "neutro")
        impacto = SEGMENTO_IMPACTO.get(segmento, "baixo")
        keywords = extract_keywords(titulo, resumo)
        entidades = extract_entidades(titulo, resumo)

        records.append({
            "noticia_id": n["id"],
            "topico": topico,
            "topico_slug": segmento or "outros",
            "relevancia": relevancia,
            "relevancia_segmento": relevancia,
            "analise_resumo": resumo[:500] if resumo else None,
            "sentimento": sentimento,
            "impacto_mercado": impacto,
            "keywords": keywords,
            "entidades": entidades,
        })

    if not records:
        print("  Todas as notícias já foram processadas.")
        return

    print(f"  Tópicos a inserir: {len(records)}")

    # Insert in batches
    batch_size = 200
    inserted = 0
    errors = 0
    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        n = insert_batch(batch)
        inserted += n
        if n > 0:
            print(f"    Batch {i // batch_size + 1}: {n} ok")
        else:
            errors += 1
            if errors >= 5:
                print("    Muitos erros consecutivos, abortando.")
                break
        time.sleep(0.5)

    print(f"\n  Inseridos: {inserted}")

    # Verify
    final = count_topicos()
    print(f"  fato_noticias_topicos final: {final}")
    print("=" * 50)
    print("ETL concluído!")


if __name__ == "__main__":
    main()
