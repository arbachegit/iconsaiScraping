"""
Embedding Generator Worker.

Finds companies without embeddings in dim_empresas.embedding,
generates embeddings using OpenAI text-embedding-3-small API,
and updates the column. Processes in batches with rate limiting.
"""

import asyncio
import json
from typing import Any

import asyncpg
import httpx
import structlog
from storage.spaces_client import SpacesClient

logger = structlog.get_logger(__name__)

BATCH_SIZE = 50
OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
OPENAI_EMBEDDING_DIMENSIONS = 1536
OPENAI_API_URL = "https://api.openai.com/v1/embeddings"
RATE_LIMIT_DELAY_SECONDS = 0.5  # Delay between batches to respect rate limits
MAX_OPENAI_BATCH = 20  # OpenAI supports up to ~2048 inputs, but we stay conservative


async def generate_pending_embeddings(
    db_pool: asyncpg.Pool | None = None,
    openai_api_key: str = "",
    spaces_client: SpacesClient | None = None,
) -> None:
    """
    Scheduled job: generate embeddings for companies that don't have them yet.

    Steps:
      1. Query dim_empresas for rows where embedding IS NULL.
      2. Build text representation for each company.
      3. Call OpenAI text-embedding-3-small in batches.
      4. Update dim_empresas.embedding column.
      5. Optionally upload to data lake.
    """
    if db_pool is None:
        logger.warning("Database pool not available, skipping embedding generation")
        return

    if not openai_api_key:
        logger.warning("OpenAI API key not configured, skipping embedding generation")
        return

    logger.info("Embedding generator started")
    processed = 0
    errors = 0

    try:
        companies = await _fetch_companies_without_embeddings(db_pool)
        if not companies:
            logger.info("No companies need embedding generation")
            return

        logger.info(
            "Found companies needing embeddings",
            count=len(companies),
        )

        # Process in batches
        for i in range(0, len(companies), MAX_OPENAI_BATCH):
            batch = companies[i : i + MAX_OPENAI_BATCH]

            try:
                batch_processed = await _process_batch(
                    batch=batch,
                    db_pool=db_pool,
                    openai_api_key=openai_api_key,
                    spaces_client=spaces_client,
                )
                processed += batch_processed
            except Exception as exc:
                errors += len(batch)
                logger.error(
                    "Batch embedding generation failed",
                    batch_start=i,
                    batch_size=len(batch),
                    error=str(exc),
                )

            # Rate limiting between batches
            if i + MAX_OPENAI_BATCH < len(companies):
                await asyncio.sleep(RATE_LIMIT_DELAY_SECONDS)

    except Exception as exc:
        logger.error(
            "Embedding generator encountered a fatal error",
            error=str(exc),
        )

    logger.info(
        "Embedding generator finished",
        processed=processed,
        errors=errors,
    )


async def generate_embeddings_for_entity(
    entity_id: str,
    db_pool: asyncpg.Pool | None = None,
    openai_api_key: str = "",
) -> None:
    """
    Generate embedding for a single entity (called from event handlers).

    Args:
        entity_id: The UUID of the company entity.
        db_pool: asyncpg connection pool.
        openai_api_key: OpenAI API key.
    """
    if db_pool is None or not openai_api_key:
        logger.warning(
            "Missing db_pool or openai_api_key for single entity embedding",
            entity_id=entity_id,
        )
        return

    try:
        async with db_pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, nome_fantasia, razao_social, cnpj,
                       atividade_principal, natureza_juridica, uf, municipio
                FROM dim_empresas
                WHERE id = $1
                """,
                entity_id,
            )

        if not row:
            logger.warning("Entity not found for embedding", entity_id=entity_id)
            return

        company = dict(row)
        text = _build_text_representation(company)

        embedding = await _call_openai_embeddings(
            texts=[text],
            api_key=openai_api_key,
        )

        if embedding and len(embedding) > 0:
            await _save_embedding(db_pool, company["id"], embedding[0])
            logger.info("Embedding generated for entity", entity_id=entity_id)
        else:
            logger.warning("No embedding returned for entity", entity_id=entity_id)

    except Exception as exc:
        logger.error(
            "Failed to generate embedding for entity",
            entity_id=entity_id,
            error=str(exc),
        )


async def _fetch_companies_without_embeddings(
    pool: asyncpg.Pool,
) -> list[dict[str, Any]]:
    """Fetch companies that don't have embeddings yet."""
    query = """
        SELECT id, nome_fantasia, razao_social, cnpj,
               atividade_principal, natureza_juridica, uf, municipio
        FROM dim_empresas
        WHERE embedding IS NULL
        ORDER BY created_at DESC
        LIMIT $1
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, BATCH_SIZE)
            return [dict(row) for row in rows]
    except asyncpg.UndefinedColumnError:
        logger.warning(
            "Column 'embedding' not found in dim_empresas. "
            "Migration may be needed to add the embedding column."
        )
        return []
    except Exception as exc:
        logger.error(
            "Failed to fetch companies without embeddings",
            error=str(exc),
        )
        return []


def _build_text_representation(company: dict[str, Any]) -> str:
    """
    Build a text string for embedding from company data.
    Combines key fields into a searchable text representation.
    """
    parts = []

    nome = company.get("nome_fantasia") or company.get("razao_social") or ""
    if nome:
        parts.append(f"Empresa: {nome}")

    razao = company.get("razao_social", "")
    if razao and razao != nome:
        parts.append(f"Razao Social: {razao}")

    cnpj = company.get("cnpj", "")
    if cnpj:
        parts.append(f"CNPJ: {cnpj}")

    atividade = company.get("atividade_principal", "")
    if atividade:
        # atividade_principal might be JSON string or plain text
        if isinstance(atividade, str):
            try:
                parsed = json.loads(atividade)
                if isinstance(parsed, list) and parsed:
                    atividade = parsed[0].get("text", str(parsed[0]))
                elif isinstance(parsed, dict):
                    atividade = parsed.get("text", str(parsed))
            except (json.JSONDecodeError, TypeError):
                pass
        parts.append(f"Atividade: {atividade}")

    natureza = company.get("natureza_juridica", "")
    if natureza:
        parts.append(f"Natureza Juridica: {natureza}")

    uf = company.get("uf", "")
    municipio = company.get("municipio", "")
    if uf or municipio:
        location = f"{municipio}/{uf}" if municipio and uf else (municipio or uf)
        parts.append(f"Local: {location}")

    return ". ".join(parts) if parts else "Empresa sem informacoes"


async def _process_batch(
    batch: list[dict[str, Any]],
    db_pool: asyncpg.Pool,
    openai_api_key: str,
    spaces_client: SpacesClient | None = None,
) -> int:
    """Process a batch of companies: generate embeddings and save them."""
    texts = [_build_text_representation(c) for c in batch]

    embeddings = await _call_openai_embeddings(
        texts=texts,
        api_key=openai_api_key,
    )

    if not embeddings or len(embeddings) != len(batch):
        logger.error(
            "Embedding count mismatch",
            expected=len(batch),
            got=len(embeddings) if embeddings else 0,
        )
        return 0

    saved = 0
    for company, embedding in zip(batch, embeddings, strict=False):
        try:
            await _save_embedding(db_pool, company["id"], embedding)
            saved += 1

            # Optionally upload embedding to data lake
            if spaces_client and spaces_client.is_configured:
                await spaces_client.upload_to_lake(
                    source="embeddings",
                    entity_id=str(company["id"]),
                    data={
                        "company_id": str(company["id"]),
                        "model": OPENAI_EMBEDDING_MODEL,
                        "dimensions": OPENAI_EMBEDDING_DIMENSIONS,
                        "text": texts[batch.index(company)],
                    },
                )
        except Exception as exc:
            logger.error(
                "Failed to save embedding",
                company_id=company["id"],
                error=str(exc),
            )

    return saved


async def _call_openai_embeddings(
    texts: list[str],
    api_key: str,
) -> list[list[float]] | None:
    """
    Call OpenAI embeddings API for a list of texts.

    Returns a list of embedding vectors, one per input text.
    """
    if not texts:
        return []

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            OPENAI_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": OPENAI_EMBEDDING_MODEL,
                "input": texts,
            },
        )

    if response.status_code != 200:
        logger.error(
            "OpenAI embeddings API error",
            status_code=response.status_code,
            response=response.text[:500],
        )
        return None

    data = response.json()
    embeddings_data = data.get("data", [])

    # Sort by index to ensure order matches input
    embeddings_data.sort(key=lambda x: x.get("index", 0))

    return [item["embedding"] for item in embeddings_data]


async def _save_embedding(
    pool: asyncpg.Pool,
    company_id: Any,
    embedding: list[float],
) -> None:
    """Save embedding vector to dim_empresas.embedding column."""
    # Store as a JSON array string that pgvector can parse,
    # or as a plain JSON array if pgvector extension is not installed.
    embedding_str = json.dumps(embedding)

    try:
        async with pool.acquire() as conn:
            # Try pgvector format first
            await conn.execute(
                "UPDATE dim_empresas SET embedding = $1::vector, updated_at = NOW() WHERE id = $2",
                embedding_str,
                company_id,
            )
    except asyncpg.UndefinedFunctionError:
        # pgvector not installed, store as JSONB
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE dim_empresas SET embedding = $1::jsonb, updated_at = NOW() WHERE id = $2",
                    embedding_str,
                    company_id,
                )
        except Exception as exc:
            logger.error(
                "Failed to save embedding as JSONB",
                company_id=company_id,
                error=str(exc),
            )
    except Exception as exc:
        logger.error(
            "Failed to save embedding",
            company_id=company_id,
            error=str(exc),
        )
