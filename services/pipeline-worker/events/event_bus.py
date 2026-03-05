"""
Postgres LISTEN/NOTIFY consumer using asyncpg.

Listens on the 'pipeline_events' channel and dispatches
parsed JSON payloads to a registered handler function.
"""

import asyncio
import json
from typing import Any, Awaitable, Callable

import asyncpg
import structlog

logger = structlog.get_logger(__name__)

CHANNEL = "pipeline_events"

EventHandler = Callable[[dict[str, Any]], Awaitable[None]]


async def start_listener(conn: asyncpg.Connection, handler: EventHandler) -> None:
    """
    Start listening on the 'pipeline_events' Postgres channel.

    This function subscribes to Postgres NOTIFY messages and dispatches
    each parsed JSON payload to the provided handler as a fire-and-forget task.

    Args:
        conn: An asyncpg connection (should be dedicated, not from a pool).
        handler: Async function that receives the parsed event dict.
    """

    async def _on_notification(
        connection: asyncpg.Connection,
        pid: int,
        channel: str,
        payload: str,
    ) -> None:
        """Internal callback for pg_notify messages."""
        try:
            event = json.loads(payload)
            logger.info(
                "Received pipeline event",
                channel=channel,
                event_type=event.get("type"),
                event_id=event.get("id"),
            )
            # Fire-and-forget: schedule handler as a task
            asyncio.create_task(_safe_handle(handler, event))
        except json.JSONDecodeError as exc:
            logger.error(
                "Failed to parse NOTIFY payload as JSON",
                channel=channel,
                payload=payload[:200],
                error=str(exc),
            )
        except Exception as exc:
            logger.error(
                "Unexpected error in notification callback",
                channel=channel,
                error=str(exc),
            )

    await conn.add_listener(CHANNEL, _on_notification)
    logger.info("Listening on Postgres channel", channel=CHANNEL)


async def _safe_handle(handler: EventHandler, event: dict[str, Any]) -> None:
    """Execute handler with error isolation so exceptions never crash the listener."""
    try:
        await handler(event)
    except Exception as exc:
        logger.error(
            "Event handler failed",
            event_type=event.get("type"),
            event_id=event.get("id"),
            error=str(exc),
        )
