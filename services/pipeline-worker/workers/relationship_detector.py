"""
Relationship Detector Worker.

Finds entities (companies) without detected relationships and triggers
the Node.js graph-pipeline endpoint to detect new relationships.
Also processes pending pipeline events of type 'company.created'.
"""

import json
from typing import Any

import asyncpg
import httpx
import structlog

logger = structlog.get_logger(__name__)

BATCH_SIZE = 20
REQUEST_TIMEOUT_SECONDS = 60


async def detect_new_relationships(
    db_pool: asyncpg.Pool | None = None,
    backend_base_url: str = "http://localhost:3000",
) -> None:
    """
    Scheduled job: find entities without relationships and detect them.

    Steps:
      1. Query for companies without relationship records.
      2. Query for pending 'company.created' pipeline events.
      3. For each, call the Node.js graph-pipeline endpoint.
      4. Update pipeline_events status.
    """
    if db_pool is None:
        logger.warning("Database pool not available, skipping relationship detection")
        return

    logger.info("Relationship detector started")
    processed = 0
    errors = 0

    try:
        # Get companies without relationships
        entities = await _fetch_entities_without_relationships(db_pool)

        # Also get pending company.created events
        pending_events = await _fetch_pending_events(db_pool)

        # Merge entity IDs (deduplicate)
        all_entity_ids = set()
        for entity in entities:
            all_entity_ids.add(str(entity["id"]))
        for event in pending_events:
            entity_id = event.get("entity_id")
            if entity_id:
                all_entity_ids.add(entity_id)

        if not all_entity_ids:
            logger.info("No entities need relationship detection")
            return

        logger.info(
            "Found entities needing relationship detection",
            count=len(all_entity_ids),
        )

        async with httpx.AsyncClient(
            base_url=backend_base_url,
            timeout=REQUEST_TIMEOUT_SECONDS,
        ) as client:
            for entity_id in list(all_entity_ids)[:BATCH_SIZE]:
                try:
                    await _detect_for_entity(
                        client=client,
                        db_pool=db_pool,
                        entity_id=entity_id,
                    )
                    processed += 1
                except Exception as exc:
                    errors += 1
                    logger.error(
                        "Failed to detect relationships",
                        entity_id=entity_id,
                        error=str(exc),
                    )

    except Exception as exc:
        logger.error(
            "Relationship detector encountered a fatal error",
            error=str(exc),
        )

    logger.info(
        "Relationship detector finished",
        processed=processed,
        errors=errors,
    )


async def detect_relationships_for_entity(
    entity_id: str,
    db_pool: asyncpg.Pool | None = None,
    backend_base_url: str = "http://localhost:3000",
) -> None:
    """
    Detect relationships for a single entity (called from event handlers).

    Args:
        entity_id: The UUID of the company entity.
        db_pool: asyncpg connection pool.
        backend_base_url: URL of the Node.js backend.
    """
    if db_pool is None:
        logger.warning("Database pool not available, skipping relationship detection")
        return

    async with httpx.AsyncClient(
        base_url=backend_base_url,
        timeout=REQUEST_TIMEOUT_SECONDS,
    ) as client:
        await _detect_for_entity(
            client=client,
            db_pool=db_pool,
            entity_id=entity_id,
        )


async def _fetch_entities_without_relationships(
    pool: asyncpg.Pool,
) -> list[dict[str, Any]]:
    """Fetch companies that have no entries in the relationship/graph tables."""
    query = """
        SELECT e.id, e.nome_fantasia, e.cnpj
        FROM dim_empresas e
        LEFT JOIN fato_transacao_empresas t ON t.empresa_id = e.id
        WHERE t.id IS NULL
        ORDER BY e.created_at DESC
        LIMIT $1
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, BATCH_SIZE)
            return [dict(row) for row in rows]
    except asyncpg.UndefinedTableError:
        logger.warning(
            "fato_transacao_empresas table not found, "
            "falling back to companies without pipeline events"
        )
        fallback_query = """
            SELECT e.id, e.nome_fantasia, e.cnpj
            FROM dim_empresas e
            WHERE NOT EXISTS (
                SELECT 1 FROM pipeline_events pe
                WHERE pe.entity_id = e.id::text
                  AND pe.event_type = 'relationships.detected'
            )
            ORDER BY e.created_at DESC
            LIMIT $1
        """
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(fallback_query, BATCH_SIZE)
                return [dict(row) for row in rows]
        except Exception as exc:
            logger.error("Fallback query failed", error=str(exc))
            return []
    except Exception as exc:
        logger.error("Failed to fetch entities without relationships", error=str(exc))
        return []


async def _fetch_pending_events(pool: asyncpg.Pool) -> list[dict[str, Any]]:
    """Fetch pending company.created pipeline events."""
    query = """
        SELECT entity_id, metadata, created_at
        FROM pipeline_events
        WHERE event_type = 'company.created'
          AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, BATCH_SIZE)
            return [dict(row) for row in rows]
    except asyncpg.UndefinedTableError:
        logger.warning("Table pipeline_events does not exist yet")
        return []
    except Exception as exc:
        logger.error("Failed to fetch pending events", error=str(exc))
        return []


async def _detect_for_entity(
    client: httpx.AsyncClient,
    db_pool: asyncpg.Pool,
    entity_id: str,
) -> None:
    """Call the graph-pipeline endpoint to detect relationships for an entity."""
    logger.info("Detecting relationships", entity_id=entity_id)

    response = await client.post(
        "/api/companies/graph-pipeline",
        json={"company_id": entity_id},
    )

    status = "success" if response.status_code == 200 else "error"
    metadata = {
        "http_status": response.status_code,
        "source": "graph-pipeline",
    }

    if response.status_code == 200:
        try:
            result = response.json()
            metadata["relationships_found"] = result.get("relationships_count", 0)
        except Exception:
            pass

    await _log_pipeline_event(
        pool=db_pool,
        event_type="relationships.detected",
        entity_id=entity_id,
        status=status,
        metadata=metadata,
    )

    # Mark any pending company.created events as processed
    await _mark_events_processed(db_pool, entity_id, "company.created")


async def _mark_events_processed(
    pool: asyncpg.Pool,
    entity_id: str,
    event_type: str,
) -> None:
    """Mark pending pipeline events as processed."""
    query = """
        UPDATE pipeline_events
        SET status = 'processed'
        WHERE entity_id = $1
          AND event_type = $2
          AND status = 'pending'
    """
    try:
        async with pool.acquire() as conn:
            await conn.execute(query, entity_id, event_type)
    except asyncpg.UndefinedTableError:
        pass
    except Exception as exc:
        logger.error("Failed to mark events as processed", error=str(exc))


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
