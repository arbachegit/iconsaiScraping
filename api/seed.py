"""
Super admin seeding via environment variables.

Creates the initial super_admin user on startup if:
- SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are set
- No user with that email exists yet

This replaces the legacy hardcoded _LEGACY_USERS_DB in auth.py.
"""

import structlog

from api.auth.auth_service import hash_password
from config.settings import settings
from src.database.client import get_supabase

logger = structlog.get_logger()


async def seed_super_admin() -> None:
    """
    Create super_admin user from environment variables (idempotent).

    Reads SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME from settings.
    Only creates if user does not already exist.
    """
    if not settings.seed_admin_email or not settings.seed_admin_password:
        logger.info("seed_admin_skipped", reason="SEED_ADMIN_EMAIL or SEED_ADMIN_PASSWORD not set")
        return

    client = get_supabase()
    if not client:
        logger.warning("seed_admin_no_db", reason="Supabase not configured")
        return

    try:
        # Check if user already exists
        existing = (
            client.table("users")
            .select("id")
            .eq("email", settings.seed_admin_email.lower())
            .limit(1)
            .execute()
        )

        if existing.data:
            logger.info(
                "seed_admin_exists",
                email=settings.seed_admin_email,
                msg="Super admin already exists, skipping seed.",
            )
            return

        # Create super_admin
        new_admin = {
            "email": settings.seed_admin_email.lower(),
            "name": settings.seed_admin_name,
            "password_hash": hash_password(settings.seed_admin_password),
            "is_admin": True,
            "role": "superadmin",
            "permissions": ["empresas", "pessoas", "politicos", "noticias"],
            "is_active": True,
            "is_verified": True,
        }

        result = client.table("users").insert(new_admin).execute()

        if result.data:
            logger.info(
                "seed_admin_created",
                email=settings.seed_admin_email,
                msg="Super admin seeded successfully.",
            )
        else:
            logger.error("seed_admin_insert_failed", email=settings.seed_admin_email)

        # Ensure all admin users have is_verified = true
        try:
            client.table("users").update(
                {"is_verified": True}
            ).eq("is_admin", True).execute()
            logger.info("seed_admin_verified_all", msg="All admin users marked as verified.")
        except Exception as ve:
            logger.warning("seed_verify_admins_error", error=str(ve))

        # Ensure seed admin has role=superadmin (backfill for existing installs)
        try:
            client.table("users").update(
                {"role": "superadmin"}
            ).eq("email", settings.seed_admin_email.lower()).execute()
            logger.info("seed_admin_role_set", msg="Seed admin role set to superadmin.")
        except Exception as re:
            logger.warning("seed_admin_role_error", error=str(re))

    except Exception as e:
        logger.error("seed_admin_error", error=str(e))
