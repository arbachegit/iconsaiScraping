"""
Event dispatch handlers for pipeline_events.

Dispatch map:
  - company.created  -> relationship_detector, embedding_generator, spaces upload
  - person.created   -> spaces upload
  - news.created     -> spaces upload

Each handler is fire-and-forget with comprehensive error logging.
"""

import asyncio
from typing import Any

import asyncpg
import structlog

from storage.spaces_client import SpacesClient
from workers.embedding_generator import generate_embeddings_for_entity
from workers.relationship_detector import detect_relationships_for_entity

logger = structlog.get_logger(__name__)


async def handle_event(
    event: dict[str, Any],
    db_pool: asyncpg.Pool | None = None,
    backend_base_url: str = "http://localhost:3000",
    openai_api_key: str = "",
    spaces_client: SpacesClient | None = None,
) -> None:
    """
    Main event dispatcher. Routes events to the appropriate handlers.

    Args:
        event: Parsed event dict with at minimum 'type' and 'data' keys.
        db_pool: asyncpg connection pool.
        backend_base_url: URL of the Node.js backend.
        openai_api_key: OpenAI API key for embedding generation.
        spaces_client: DigitalOcean Spaces client for data lake uploads.
    """
    event_type = event.get("type", "unknown")
    event_data = event.get("data", {})
    event_id = event.get("id", "no-id")

    logger.info(
        "Dispatching event",
        event_type=event_type,
        event_id=event_id,
    )

    handlers = EVENT_DISPATCH.get(event_type, [])

    if not handlers:
        logger.warning("No handlers registered for event type", event_type=event_type)
        return

    tasks = []
    for handler_fn in handlers:
        tasks.append(
            _safe_execute(
                handler_fn,
                event_type=event_type,
                event_id=event_id,
                event_data=event_data,
                db_pool=db_pool,
                backend_base_url=backend_base_url,
                openai_api_key=openai_api_key,
                spaces_client=spaces_client,
            )
        )

    await asyncio.gather(*tasks)
    logger.info(
        "Event dispatched to all handlers",
        event_type=event_type,
        handler_count=len(handlers),
    )


async def _safe_execute(
    handler_fn: Any,
    event_type: str,
    event_id: str,
    event_data: dict[str, Any],
    **kwargs: Any,
) -> None:
    """Execute a single handler with error isolation."""
    handler_name = handler_fn.__name__
    try:
        await handler_fn(event_data=event_data, **kwargs)
        logger.info(
            "Handler completed",
            handler=handler_name,
            event_type=event_type,
            event_id=event_id,
        )
    except Exception as exc:
        logger.error(
            "Handler failed",
            handler=handler_name,
            event_type=event_type,
            event_id=event_id,
            error=str(exc),
        )


# ---------------------------------------------------------------------------
# Individual event handlers
# ---------------------------------------------------------------------------


async def _handle_company_created_relationships(
    event_data: dict[str, Any],
    db_pool: asyncpg.Pool | None = None,
    backend_base_url: str = "",
    **kwargs: Any,
) -> None:
    """Detect relationships for a newly created company."""
    entity_id = event_data.get("id") or event_data.get("company_id")
    if not entity_id:
        logger.warning("company.created event missing id")
        return
    await detect_relationships_for_entity(
        entity_id=entity_id,
        db_pool=db_pool,
        backend_base_url=backend_base_url,
    )


async def _handle_company_created_embeddings(
    event_data: dict[str, Any],
    db_pool: asyncpg.Pool | None = None,
    openai_api_key: str = "",
    **kwargs: Any,
) -> None:
    """Generate embeddings for a newly created company."""
    entity_id = event_data.get("id") or event_data.get("company_id")
    if not entity_id:
        logger.warning("company.created event missing id for embeddings")
        return
    await generate_embeddings_for_entity(
        entity_id=entity_id,
        db_pool=db_pool,
        openai_api_key=openai_api_key,
    )


async def _handle_company_created_upload(
    event_data: dict[str, Any],
    spaces_client: SpacesClient | None = None,
    **kwargs: Any,
) -> None:
    """Upload company data to the data lake."""
    if spaces_client is None:
        return
    entity_id = event_data.get("id") or event_data.get("company_id") or "unknown"
    await spaces_client.upload_to_lake(
        source="company",
        entity_id=str(entity_id),
        data=event_data,
    )


async def _handle_person_created_upload(
    event_data: dict[str, Any],
    spaces_client: SpacesClient | None = None,
    **kwargs: Any,
) -> None:
    """Upload person data to the data lake."""
    if spaces_client is None:
        return
    entity_id = event_data.get("id") or event_data.get("person_id") or "unknown"
    await spaces_client.upload_to_lake(
        source="person",
        entity_id=str(entity_id),
        data=event_data,
    )


async def _handle_news_created_upload(
    event_data: dict[str, Any],
    spaces_client: SpacesClient | None = None,
    **kwargs: Any,
) -> None:
    """Upload news data to the data lake."""
    if spaces_client is None:
        return
    entity_id = event_data.get("id") or event_data.get("news_id") or "unknown"
    await spaces_client.upload_to_lake(
        source="news",
        entity_id=str(entity_id),
        data=event_data,
    )


# ---------------------------------------------------------------------------
# Event dispatch map
# ---------------------------------------------------------------------------

EVENT_DISPATCH: dict[str, list[Any]] = {
    "company.created": [
        _handle_company_created_relationships,
        _handle_company_created_embeddings,
        _handle_company_created_upload,
    ],
    "person.created": [
        _handle_person_created_upload,
    ],
    "news.created": [
        _handle_news_created_upload,
    ],
}
