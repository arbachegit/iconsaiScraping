"""
News Collector Worker.

Fetches news for companies that haven't been checked in the last 24 hours.
Uses httpx to call the Node.js backend's news enrichment endpoints.
Stores raw responses in raw_api_responses and updates pipeline_events status.
"""

from typing import Any

import asyncpg
import httpx
import structlog

logger = structlog.get_logger(__name__)

# Companies not checked for news in this many hours are considered stale
STALE_THRESHOLD_HOURS = 24
BATCH_SIZE = 20
REQUEST_TIMEOUT_SECONDS = 30


async def collect_news(
    db_pool: asyncpg.Pool | None = None,
    backend_base_url: str = "http://localhost:3000",
) -> None:
    """
    Scheduled job: fetch news for companies not checked in the last 24 hours.

    Steps:
      1. Query dim_empresas for companies with stale or missing news_checked_at.
      2. For each company, call the Node.js backend news enrichment endpoint.
      3. Store raw API response in raw_api_responses.
      4. Log pipeline event with status.
    """
    if db_pool is None:
        logger.warning("Database pool not available, skipping news collection")
        return

    logger.info("News collector started")
    processed = 0
    errors = 0

    try:
        companies = await _fetch_stale_companies(db_pool)
        if not companies:
            logger.info("No companies need news collection")
            return

        logger.info("Found companies needing news collection", count=len(companies))

        async with httpx.AsyncClient(
            base_url=backend_base_url,
            timeout=REQUEST_TIMEOUT_SECONDS,
        ) as client:
            for company in companies:
                try:
                    await _collect_news_for_company(
                        client=client,
                        db_pool=db_pool,
                        company=company,
                    )
                    processed += 1
                except Exception as exc:
                    errors += 1
                    logger.error(
                        "Failed to collect news for company",
                        company_id=company["id"],
                        company_name=company.get("nome_fantasia", "unknown"),
                        error=str(exc),
                    )

    except Exception as exc:
        logger.error("News collector encountered a fatal error", error=str(exc))

    logger.info(
        "News collector finished",
        processed=processed,
        errors=errors,
    )


async def _fetch_stale_companies(pool: asyncpg.Pool) -> list[dict[str, Any]]:
    """Fetch companies that haven't had news checked recently."""
    query = """
        SELECT id, nome_fantasia, razao_social, cnpj
        FROM dim_empresas
        WHERE news_checked_at IS NULL
           OR news_checked_at < NOW() - INTERVAL '$1 hours'
        ORDER BY news_checked_at ASC NULLS FIRST
        LIMIT $2
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, STALE_THRESHOLD_HOURS, BATCH_SIZE)
            return [dict(row) for row in rows]
    except asyncpg.UndefinedColumnError:
        # Column news_checked_at may not exist yet; fall back to all companies
        logger.warning(
            "Column news_checked_at not found in dim_empresas. "
            "Falling back to companies without recent pipeline events."
        )
        fallback_query = """
            SELECT e.id, e.nome_fantasia, e.razao_social, e.cnpj
            FROM dim_empresas e
            LEFT JOIN (
                SELECT DISTINCT ON (entity_id) entity_id, created_at
                FROM pipeline_events
                WHERE event_type = 'news.collected'
                ORDER BY entity_id, created_at DESC
            ) pe ON pe.entity_id = e.id::text
            WHERE pe.created_at IS NULL
               OR pe.created_at < NOW() - INTERVAL '24 hours'
            ORDER BY pe.created_at ASC NULLS FIRST
            LIMIT $1
        """
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(fallback_query, BATCH_SIZE)
                return [dict(row) for row in rows]
        except Exception as exc:
            logger.error("Fallback query also failed", error=str(exc))
            return []


async def _collect_news_for_company(
    client: httpx.AsyncClient,
    db_pool: asyncpg.Pool,
    company: dict[str, Any],
) -> None:
    """Call the backend news endpoint and store the raw response."""
    company_id = company["id"]
    company_name = company.get("nome_fantasia") or company.get("razao_social") or ""

    if not company_name:
        logger.debug("Skipping company without name", company_id=company_id)
        return

    # Call the Node.js backend news enrichment endpoint
    response = await client.post(
        "/api/companies/news",
        json={"company_name": company_name, "cnpj": company.get("cnpj", "")},
    )

    response_data = response.json() if response.status_code == 200 else {
        "error": response.text,
        "status_code": response.status_code,
    }

    # Store raw response
    await _store_raw_response(
        pool=db_pool,
        source="news_enrichment",
        entity_id=str(company_id),
        response_data=response_data,
        http_status=response.status_code,
    )

    # Log pipeline event
    await _log_pipeline_event(
        pool=db_pool,
        event_type="news.collected",
        entity_id=str(company_id),
        status="success" if response.status_code == 200 else "error",
        metadata={"http_status": response.status_code},
    )

    # Update news_checked_at if column exists
    try:
        async with db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE dim_empresas SET news_checked_at = NOW() WHERE id = $1",
                company_id,
            )
    except asyncpg.UndefinedColumnError:
        pass  # Column doesn't exist yet, skip silently


async def _store_raw_response(
    pool: asyncpg.Pool,
    source: str,
    entity_id: str,
    response_data: dict[str, Any],
    http_status: int,
) -> None:
    """Store raw API response for audit trail."""
    query = """
        INSERT INTO raw_api_responses (source, entity_id, response_data, http_status, fetched_at)
        VALUES ($1, $2, $3::jsonb, $4, NOW())
        ON CONFLICT DO NOTHING
    """
    try:
        async with pool.acquire() as conn:
            import json
            await conn.execute(
                query,
                source,
                entity_id,
                json.dumps(response_data, ensure_ascii=False, default=str),
                http_status,
            )
    except asyncpg.UndefinedTableError:
        logger.warning("Table raw_api_responses does not exist yet, skipping storage")
    except Exception as exc:
        logger.error("Failed to store raw response", error=str(exc))


async def _log_pipeline_event(
    pool: asyncpg.Pool,
    event_type: str,
    entity_id: str,
    status: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Log a pipeline event for tracking."""
    query = """
        INSERT INTO pipeline_events (event_type, entity_id, status, metadata, created_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW())
    """
    try:
        async with pool.acquire() as conn:
            import json
            await conn.execute(
                query,
                event_type,
                entity_id,
                status,
                json.dumps(metadata or {}, default=str),
            )
    except asyncpg.UndefinedTableError:
        logger.warning("Table pipeline_events does not exist yet")
    except Exception as exc:
        logger.error("Failed to log pipeline event", error=str(exc))
