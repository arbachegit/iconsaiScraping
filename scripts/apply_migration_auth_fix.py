"""
Apply Auth Level 1 Fix migration to Supabase database.

Replaces `role VARCHAR` with `is_admin BOOLEAN` (Level 1 compliance).

Usage:
    python scripts/apply_migration_auth_fix.py

Reads SQL from database/migrations/migration_auth_level1_fix.sql
and executes each statement against the Supabase PostgreSQL database.

Requires: DATABASE_URL or SUPABASE_URL + SUPABASE_SERVICE_KEY in .env
"""

import os
import re
import sys
from pathlib import Path

import structlog
from dotenv import load_dotenv

# Add project root to path
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

load_dotenv(project_root / ".env")

logger = structlog.get_logger()


def get_database_url() -> str:
    """
    Get PostgreSQL connection URL.

    Tries DATABASE_URL first, then constructs from SUPABASE_URL.
    """
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url

    supabase_url = os.getenv("SUPABASE_URL", "")

    if not supabase_url:
        raise ValueError("DATABASE_URL or SUPABASE_URL must be set in .env")

    supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "")

    match = re.match(r"https://([^.]+)\.supabase\.co", supabase_url)
    if not match:
        raise ValueError(f"Cannot parse Supabase URL: {supabase_url}")

    project_ref = match.group(1)
    return f"postgresql://postgres.{project_ref}:{supabase_key}@aws-0-us-west-2.pooler.supabase.com:6543/postgres"


def apply_migration() -> None:
    """Read and execute the migration SQL file."""
    import psycopg2

    migration_file = project_root / "database" / "migrations" / "migration_auth_level1_fix.sql"

    if not migration_file.exists():
        logger.error("migration_file_not_found", path=str(migration_file))
        sys.exit(1)

    sql_content = migration_file.read_text(encoding="utf-8")
    logger.info("migration_loaded", file=str(migration_file), size=len(sql_content))

    # Split into individual statements
    statements = [
        s.strip()
        for s in sql_content.split(";")
        if s.strip() and not s.strip().startswith("--")
    ]

    logger.info("statements_found", count=len(statements))

    database_url = get_database_url()
    logger.info("connecting_to_database")

    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    cur = conn.cursor()

    success_count = 0
    error_count = 0

    for i, stmt in enumerate(statements, 1):
        clean_stmt = "\n".join(
            line for line in stmt.split("\n")
            if line.strip() and not line.strip().startswith("--")
        )
        if not clean_stmt:
            continue

        try:
            cur.execute(clean_stmt)
            success_count += 1
            preview = clean_stmt.replace("\n", " ")[:80]
            logger.info("statement_ok", num=i, sql=preview)
        except Exception as e:
            error_count += 1
            preview = clean_stmt.replace("\n", " ")[:80]
            logger.error("statement_failed", num=i, sql=preview, error=str(e))
            conn.rollback()
            conn.autocommit = False

    if error_count == 0:
        conn.commit()
        logger.info(
            "migration_complete",
            success=success_count,
            errors=error_count,
            msg="All statements executed successfully.",
        )
    else:
        logger.warning(
            "migration_partial",
            success=success_count,
            errors=error_count,
            msg="Some statements failed. Review errors above.",
        )

    # Validate: check is_admin column exists
    try:
        cur2 = conn.cursor()
        cur2.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'is_admin'
        """)
        if cur2.fetchone():
            logger.info("validation_ok", msg="Column 'is_admin' exists in users table.")
        else:
            logger.error("validation_failed", msg="Column 'is_admin' NOT found in users table.")

        # Check role column is gone
        cur2.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'role'
        """)
        if cur2.fetchone():
            logger.warning("validation_warning", msg="Column 'role' still exists in users table.")
        else:
            logger.info("validation_ok", msg="Column 'role' successfully removed from users table.")

        # Count admins
        cur2.execute("SELECT COUNT(*) FROM users WHERE is_admin = true")
        admin_count = cur2.fetchone()[0]
        logger.info("admin_count", count=admin_count, msg=f"{admin_count} admin(s) found after migration.")

        cur2.close()
    except Exception as e:
        logger.warning("validation_error", error=str(e))

    cur.close()
    conn.close()


if __name__ == "__main__":
    print("=" * 60)
    print("Auth Level 1 Fix Migration - role -> is_admin")
    print("=" * 60)
    apply_migration()
    print("=" * 60)
    print("Done. Check logs above for results.")
