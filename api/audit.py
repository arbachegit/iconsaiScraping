"""
Audit logging service.

Records user actions for security auditing and compliance.
All entries are stored in the audit_logs table via Supabase.
"""

from typing import Any, Dict, Optional

import structlog
from fastapi import Request

from src.database.client import get_supabase

logger = structlog.get_logger()


async def log_action(
    user_id: Optional[int],
    action: str,
    resource: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    request: Optional[Request] = None,
) -> None:
    """
    Log an auditable action.

    Args:
        user_id: ID of the user performing the action (None for system actions).
        action: Action identifier (e.g., 'user.login', 'user.created').
        resource: Resource affected (e.g., 'users/5').
        details: Additional context as a dict.
        request: FastAPI Request for extracting IP and user-agent.
    """
    ip_address = None
    user_agent = None

    if request:
        # Extract real IP (handles proxies)
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            ip_address = forwarded.split(",")[0].strip()
        else:
            ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")

    client = get_supabase()
    if not client:
        # Fallback: log to structlog if DB unavailable
        logger.warning(
            "audit_log_no_db",
            user_id=user_id,
            action=action,
            resource=resource,
            details=details,
            ip_address=ip_address,
        )
        return

    try:
        entry = {
            "user_id": user_id,
            "action": action,
            "resource": resource,
            "details": details,
            "ip_address": ip_address,
            "user_agent": user_agent,
        }
        client.table("audit_logs").insert(entry).execute()
        logger.info("audit_logged", action=action, user_id=user_id)
    except Exception as e:
        # Never fail the main operation because of audit logging
        logger.error(
            "audit_log_failed",
            action=action,
            user_id=user_id,
            error=str(e),
        )
