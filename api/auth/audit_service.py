"""
Audit logging service.

Records user actions for security auditing and compliance.

Moved from api/audit.py to api/auth/audit_service.py
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
    tenant_id: Optional[str] = None,
    data_classification: Optional[str] = None,
    affected_entity_type: Optional[str] = None,
    affected_entity_id: Optional[str] = None,
    previous_state: Optional[Dict[str, Any]] = None,
    new_state: Optional[Dict[str, Any]] = None,
) -> None:
    """Log an auditable action with enhanced FASE 7 fields."""
    ip_address = None
    user_agent = None

    if request:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            ip_address = forwarded.split(",")[0].strip()
        else:
            ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")

    client = get_supabase()
    if not client:
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

        # Enhanced FASE 7 fields (added conditionally for backward compat)
        if tenant_id is not None:
            entry["tenant_id"] = tenant_id
        if data_classification is not None:
            entry["data_classification"] = data_classification
        if affected_entity_type is not None:
            entry["affected_entity_type"] = affected_entity_type
        if affected_entity_id is not None:
            entry["affected_entity_id"] = str(affected_entity_id)
        if previous_state is not None:
            entry["previous_state"] = previous_state
        if new_state is not None:
            entry["new_state"] = new_state

        client.table("audit_logs").insert(entry).execute()
        logger.info("audit_logged", action=action, user_id=user_id, entity_type=affected_entity_type)
    except Exception as e:
        logger.error(
            "audit_log_failed",
            action=action,
            user_id=user_id,
            error=str(e),
        )
