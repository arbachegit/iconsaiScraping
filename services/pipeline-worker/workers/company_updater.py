"""
Company Updater Worker.

Re-checks companies that haven't been updated in the last 7 days.
Calls BrasilAPI for fresh data, compares with existing records,
logs changes, and updates pipeline_events.
"""

import json
from datetime import datetime, timezone
from typing import Any

import asyncpg
import httpx
import structlog

logger = structlog.get_logger(__name__)

STALE_DAYS = 7
BATCH_SIZE = 15
REQUEST_TIMEOUT_SECONDS = 30


async def update_stale_companies(
    db_pool: asyncpg.Pool | None = None,
    backend_base_url: str = "http://localhost:3000",
) -> None:
    """
    Scheduled job: re-check companies not updated in the last 7 days.

    Steps:
      1. Query dim_empresas for companies with stale updated_at.
      2. For each company with a valid CNPJ, call BrasilAPI for fresh data.
      3. Compare with existing record and log any changes.
      4. Update the record if changes detected.
      5. Log pipeline event with status.
    """
    if db_pool is None:
        logger.warning("Database pool not available, skipping company updates")
        return

    logger.info("Company updater started")
    processed = 0
    updated = 0
    errors = 0

    try:
        companies = await _fetch_stale_companies(db_pool)
        if not companies:
            logger.info("No stale companies found")
            return

        logger.info("Found stale companies", count=len(companies))

        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            for company in companies:
                try:
                    changed = await _update_company(
                        client=client,
                        db_pool=db_pool,
                        company=company,
                    )
                    processed += 1
                    if changed:
                        updated += 1
                except Exception as exc:
                    errors += 1
                    logger.error(
                        "Failed to update company",
                        company_id=company["id"],
                        cnpj=company.get("cnpj", "unknown"),
                        error=str(exc),
                    )

    except Exception as exc:
        logger.error("Company updater encountered a fatal error", error=str(exc))

    logger.info(
        "Company updater finished",
        processed=processed,
        updated=updated,
        errors=errors,
    )


async def _fetch_stale_companies(pool: asyncpg.Pool) -> list[dict[str, Any]]:
    """Fetch companies not updated in the last N days."""
    query = """
        SELECT id, cnpj, razao_social, nome_fantasia,
               situacao_cadastral, updated_at
        FROM dim_empresas
        WHERE cnpj IS NOT NULL
          AND LENGTH(TRIM(cnpj)) >= 11
          AND (updated_at IS NULL OR updated_at < NOW() - INTERVAL '$1 days')
        ORDER BY updated_at ASC NULLS FIRST
        LIMIT $2
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, STALE_DAYS, BATCH_SIZE)
            return [dict(row) for row in rows]
    except Exception as exc:
        logger.error("Failed to fetch stale companies", error=str(exc))
        return []


async def _update_company(
    client: httpx.AsyncClient,
    db_pool: asyncpg.Pool,
    company: dict[str, Any],
) -> bool:
    """
    Fetch fresh data from BrasilAPI and update if there are changes.

    Returns True if the company was updated, False otherwise.
    """
    cnpj = company.get("cnpj", "").replace(".", "").replace("/", "").replace("-", "")
    company_id = company["id"]

    if not cnpj or len(cnpj) < 11:
        logger.debug("Skipping company with invalid CNPJ", company_id=company_id)
        return False

    # Call BrasilAPI
    response = await client.get(f"https://brasilapi.com.br/api/cnpj/v1/{cnpj}")

    if response.status_code != 200:
        logger.warning(
            "BrasilAPI returned non-200",
            cnpj=cnpj,
            status_code=response.status_code,
        )
        await _log_pipeline_event(
            pool=db_pool,
            event_type="company.update_check",
            entity_id=str(company_id),
            status="error",
            metadata={"http_status": response.status_code, "source": "brasilapi"},
        )
        return False

    fresh_data = response.json()

    # Compare and detect changes
    changes = _detect_changes(company, fresh_data)

    if changes:
        logger.info(
            "Changes detected for company",
            company_id=company_id,
            cnpj=cnpj,
            changes=list(changes.keys()),
        )
        await _apply_updates(db_pool, company_id, changes)
        await _log_pipeline_event(
            pool=db_pool,
            event_type="company.updated",
            entity_id=str(company_id),
            status="success",
            metadata={"changes": changes, "source": "brasilapi"},
        )
        return True
    else:
        # No changes, just update the timestamp
        await _touch_updated_at(db_pool, company_id)
        await _log_pipeline_event(
            pool=db_pool,
            event_type="company.update_check",
            entity_id=str(company_id),
            status="no_changes",
            metadata={"source": "brasilapi"},
        )
        return False


def _detect_changes(
    existing: dict[str, Any],
    fresh: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """
    Compare existing company record with fresh BrasilAPI data.
    Returns a dict of changed fields with old and new values.
    """
    field_mapping = {
        "razao_social": "razao_social",
        "nome_fantasia": "nome_fantasia",
        "situacao_cadastral": "descricao_situacao_cadastral",
    }

    changes: dict[str, dict[str, Any]] = {}

    for local_field, api_field in field_mapping.items():
        old_value = existing.get(local_field)
        new_value = fresh.get(api_field)

        if new_value and old_value != new_value:
            changes[local_field] = {
                "old": old_value,
                "new": new_value,
            }

    return changes


async def _apply_updates(
    pool: asyncpg.Pool,
    company_id: Any,
    changes: dict[str, dict[str, Any]],
) -> None:
    """Apply detected changes to dim_empresas."""
    if not changes:
        return

    set_clauses = []
    values = []
    param_idx = 1

    for field, change in changes.items():
        set_clauses.append(f"{field} = ${param_idx}")
        values.append(change["new"])
        param_idx += 1

    set_clauses.append(f"updated_at = NOW()")

    query = f"""
        UPDATE dim_empresas
        SET {', '.join(set_clauses)}
        WHERE id = ${param_idx}
    """
    values.append(company_id)

    try:
        async with pool.acquire() as conn:
            await conn.execute(query, *values)
    except Exception as exc:
        logger.error("Failed to apply updates", company_id=company_id, error=str(exc))


async def _touch_updated_at(pool: asyncpg.Pool, company_id: Any) -> None:
    """Update only the updated_at timestamp."""
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE dim_empresas SET updated_at = NOW() WHERE id = $1",
                company_id,
            )
    except Exception as exc:
        logger.error("Failed to touch updated_at", company_id=company_id, error=str(exc))


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
            await conn.execute(
                query,
                event_type,
                entity_id,
                status,
                json.dumps(metadata or {}, ensure_ascii=False, default=str),
            )
    except asyncpg.UndefinedTableError:
        logger.warning("Table pipeline_events does not exist yet")
    except Exception as exc:
        logger.error("Failed to log pipeline event", error=str(exc))
