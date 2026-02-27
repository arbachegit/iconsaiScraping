"""
Apply Auth Address migration to Supabase database.

Usage:
    python scripts/apply_migration_auth_address.py

Adds address fields (cep, logradouro, numero, complemento, bairro, cidade, uf)
to the users table for profile completion flow.

Requires: SUPABASE_URL + SUPABASE_SERVICE_KEY in .env
Uses Supabase SQL HTTP API (no psycopg2/DATABASE_URL needed).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import structlog
from dotenv import load_dotenv

# Add project root to path
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

load_dotenv(project_root / ".env")

logger = structlog.get_logger()


def execute_sql_via_supabase(sql: str) -> dict:
    """Execute SQL via Supabase SQL HTTP API (stdlib only, no httpx/requests)."""
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    service_key = os.getenv("SUPABASE_SERVICE_KEY", "")

    if not supabase_url or not service_key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }

    body = json.dumps({"query": sql}).encode("utf-8")

    # Try Supabase pg/query endpoint first
    pg_url = f"{supabase_url}/pg/query"
    req = urllib.request.Request(pg_url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        pass

    # Fallback: REST rpc endpoint (requires exec_sql function)
    rpc_url = f"{supabase_url}/rest/v1/rpc/exec_sql"
    body_rpc = json.dumps({"sql": sql}).encode("utf-8")
    req = urllib.request.Request(rpc_url, data=body_rpc, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"SQL execution failed (HTTP {e.code}): {e.read().decode('utf-8', errors='replace')}"
        ) from e


def apply_migration() -> None:
    """Read and execute the migration SQL statements."""
    migration_file = project_root / "database" / "migrations" / "migration_auth_address.sql"

    if not migration_file.exists():
        logger.error("migration_file_not_found", path=str(migration_file))
        sys.exit(1)

    sql_content = migration_file.read_text(encoding="utf-8")
    logger.info("migration_loaded", file=str(migration_file), size=len(sql_content))

    statements = [
        s.strip()
        for s in sql_content.split(";")
        if s.strip() and not s.strip().startswith("--")
    ]

    logger.info("statements_found", count=len(statements))

    success_count = 0
    error_count = 0

    for i, stmt in enumerate(statements, 1):
        clean_stmt = "\n".join(
            line for line in stmt.split("\n")
            if line.strip() and not line.strip().startswith("--")
        )
        if not clean_stmt:
            continue

        preview = clean_stmt.replace("\n", " ")[:80]

        try:
            execute_sql_via_supabase(clean_stmt)
            success_count += 1
            logger.info("statement_ok", num=i, sql=preview)
        except Exception as e:
            error_count += 1
            logger.error("statement_failed", num=i, sql=preview, error=str(e))

    if error_count == 0:
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


if __name__ == "__main__":
    print("=" * 60)
    print("Auth Address Migration - IconsAI Scraping")
    print("=" * 60)
    apply_migration()
    print("=" * 60)
    print("Done. Check logs above for results.")
