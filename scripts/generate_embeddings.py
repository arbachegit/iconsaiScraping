"""
Generate embeddings for dim_empresas using OpenAI text-embedding-3-small.

Prerequisites:
    - pgvector extension enabled in Supabase
    - Migration 021 applied (embedding column exists)
    - OPENAI_API_KEY set in environment

Usage:
    python scripts/generate_embeddings.py
    python scripts/generate_embeddings.py --batch-size 100
    python scripts/generate_embeddings.py --limit 500
"""

import argparse
import os
import sys
import time

import httpx
import structlog

logger = structlog.get_logger()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
HEADERS = {}


def init() -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        logger.error("missing_env", msg="SUPABASE_URL and SUPABASE_SERVICE_KEY required")
        sys.exit(1)
    if not OPENAI_API_KEY:
        logger.error("missing_env", msg="OPENAI_API_KEY required for embedding generation")
        sys.exit(1)

    global HEADERS
    HEADERS = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_KEY,
    }


def fetch_companies_without_embeddings(limit: int = 1000) -> list:
    """Fetch companies that don't have embeddings yet."""
    url = (
        f"{SUPABASE_URL}/rest/v1/dim_empresas"
        f"?select=id,razao_social,nome_fantasia,descricao,cidade,estado,cnpj"
        f"&embedding=is.null"
        f"&limit={limit}"
        f"&order=id.asc"
    )
    headers = {**HEADERS, "Prefer": "return=representation"}
    resp = httpx.get(url, headers=headers, timeout=30)

    if resp.status_code >= 400:
        logger.error("fetch_error", status=resp.status_code, body=resp.text[:200])
        return []

    return resp.json() if resp.text else []


def build_embedding_text(company: dict) -> str:
    """Build text representation for embedding."""
    parts = []

    if company.get("razao_social"):
        parts.append(f"Razão Social: {company['razao_social']}")
    if company.get("nome_fantasia"):
        parts.append(f"Nome Fantasia: {company['nome_fantasia']}")
    if company.get("descricao"):
        parts.append(f"Descrição: {company['descricao']}")
    if company.get("cidade"):
        location = company["cidade"]
        if company.get("estado"):
            location += f"/{company['estado']}"
        parts.append(f"Localização: {location}")

    text = ". ".join(parts) if parts else f"Empresa CNPJ {company.get('cnpj', 'desconhecido')}"
    # Truncate to ~8000 chars (well within token limits)
    return text[:8000]


def generate_embeddings_batch(texts: list[str]) -> list[list[float]]:
    """Call OpenAI API to generate embeddings for a batch of texts."""
    url = "https://api.openai.com/v1/embeddings"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    resp = httpx.post(
        url,
        json={
            "model": EMBEDDING_MODEL,
            "input": texts,
        },
        headers=headers,
        timeout=60,
    )

    if resp.status_code >= 400:
        logger.error("openai_error", status=resp.status_code, body=resp.text[:500])
        return []

    data = resp.json()
    return [item["embedding"] for item in data.get("data", [])]


def update_company_embedding(company_id: int, embedding: list[float]) -> bool:
    """Update embedding column for a company."""
    url = f"{SUPABASE_URL}/rest/v1/dim_empresas?id=eq.{company_id}"
    headers = {
        **HEADERS,
        "Prefer": "return=minimal",
    }

    # pgvector expects array format
    resp = httpx.patch(
        url,
        json={"embedding": embedding},
        headers=headers,
        timeout=15,
    )

    if resp.status_code >= 400:
        logger.warn("update_error", company_id=company_id, status=resp.status_code)
        return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate embeddings for companies")
    parser.add_argument("--batch-size", type=int, default=50, help="Batch size for OpenAI API")
    parser.add_argument("--limit", type=int, default=5000, help="Max companies to process")
    args = parser.parse_args()

    init()

    companies = fetch_companies_without_embeddings(args.limit)
    total = len(companies)

    if total == 0:
        logger.info("no_companies", msg="All companies already have embeddings")
        return

    logger.info("embedding_start", total=total, batch_size=args.batch_size, model=EMBEDDING_MODEL)

    processed = 0
    errors = 0

    for i in range(0, total, args.batch_size):
        batch = companies[i : i + args.batch_size]
        texts = [build_embedding_text(c) for c in batch]

        embeddings = generate_embeddings_batch(texts)

        if len(embeddings) != len(batch):
            logger.error("batch_mismatch", expected=len(batch), got=len(embeddings))
            errors += len(batch)
            continue

        for company, embedding in zip(batch, embeddings, strict=False):
            ok = update_company_embedding(company["id"], embedding)
            if ok:
                processed += 1
            else:
                errors += 1

        logger.info(
            "batch_complete",
            batch=i // args.batch_size + 1,
            processed=processed,
            errors=errors,
            remaining=total - processed - errors,
        )

        # Rate limit: 3000 RPM for text-embedding-3-small
        time.sleep(0.5)

    logger.info("embedding_complete", total=total, processed=processed, errors=errors)

    if processed > 0:
        logger.info(
            "next_step",
            msg="Run this SQL to create HNSW index: "
            "CREATE INDEX idx_empresas_embedding ON dim_empresas USING hnsw(embedding vector_cosine_ops);",
        )


if __name__ == "__main__":
    main()
