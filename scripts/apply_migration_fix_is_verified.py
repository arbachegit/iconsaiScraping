"""
Apply is_verified fix migration to Supabase database.

Usage:
    python scripts/apply_migration_fix_is_verified.py

Ensures existing admin/active users have is_verified = true
so they can log in after the is_verified check was added.

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
    """Get PostgreSQL connection URL."""
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url

    supabase_url = os.getenv("SUPABASE_URL", "")

    if not supabase_url:
        raise ValueError("DATABASE_URL or SUPABASE_URL must be set in .env")

    match = re.match(r"https://([^.]+)\.supabase\.co", supabase_url)
    if not match:
        raise ValueError(f"Cannot parse Supabase URL: {supabase_url}")

    project_ref = match.group(1)
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "")
    return f"postgresql://postgres.{project_ref}:{supabase_key}@aws-0-us-west-2.pooler.supabase.com:6543/postgres"


def apply_migration() -> None:
    """Read and execute the migration SQL file."""
    import psycopg2

    migration_file = project_root / "database" / "migrations" / "migration_fix_is_verified.sql"

    if not migration_file.exists():
        logger.error("migration_file_not_found", path=str(migration_file))
        sys.exit(1)

    sql_content = migration_file.read_text(encoding="utf-8")
    logger.info("migration_loaded", file=str(migration_file), size=len(sql_content))

    # Split into individual statements and strip comment-only lines
    raw_parts = sql_content.split(";")
    statements = []
    for part in raw_parts:
        # Strip comment lines, keep only SQL
        clean = "\n".join(
            line for line in part.split("\n")
            if line.strip() and not line.strip().startswith("--")
        ).strip()
        if clean:
            statements.append(clean)

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

    cur.close()
    conn.close()


if __name__ == "__main__":
    print("=" * 60)
    print("Fix is_verified Migration - IconsAI Scraping")
    print("=" * 60)
    apply_migration()
    print("=" * 60)
    print("Done. Check logs above for results.")
