"""
Apply migration 034: Re-add enrichment columns to dim_pessoas.

Columns were removed by migrations 004/005 for star schema normalization,
but people from external sources (Apollo/Perplexity/Serper) need these
columns directly on dim_pessoas since they don't have fato_transacao_empresas records.

Usage:
    python scripts/apply_migration_034_pessoas_enrichment.py
"""

import os
import sys
from pathlib import Path

import httpx
import structlog

logger = structlog.get_logger()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

MIGRATION_FILE = Path(__file__).parent.parent / "backend" / "database" / "migrations" / "034_readd_pessoas_enrichment_columns.sql"


def execute_sql_via_supabase(sql: str) -> dict:
    """Execute SQL via Supabase HTTP API."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        logger.error("missing_env", msg="SUPABASE_URL and SUPABASE_SERVICE_KEY required")
        sys.exit(1)

    url = f"{SUPABASE_URL}/pg/query"
    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_KEY,
    }

    response = httpx.post(url, json={"query": sql}, headers=headers, timeout=30)

    if response.status_code >= 400:
        logger.error("sql_error", status=response.status_code, body=response.text)
        return {"error": response.text}

    return response.json() if response.text else {}


def main() -> None:
    if not MIGRATION_FILE.exists():
        logger.error("migration_not_found", path=str(MIGRATION_FILE))
        sys.exit(1)

    sql = MIGRATION_FILE.read_text()
    statements = [s.strip() for s in sql.split(";") if s.strip() and not s.strip().startswith("--")]

    logger.info("migration_start", file="034_readd_pessoas_enrichment_columns.sql", statements=len(statements))

    for i, stmt in enumerate(statements, 1):
        if not stmt:
            continue
        logger.info("executing_statement", index=i, preview=stmt[:80])
        result = execute_sql_via_supabase(stmt + ";")
        if "error" in result:
            logger.error("statement_failed", index=i, error=result["error"])
        else:
            logger.info("statement_ok", index=i)

    logger.info("migration_complete", file="034_readd_pessoas_enrichment_columns.sql")


if __name__ == "__main__":
    main()
