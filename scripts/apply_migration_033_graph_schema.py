"""
Apply migration 033: expand graph schema to support mandato entities and extra relation types.

Usage:
    python scripts/apply_migration_033_graph_schema.py
"""

import os
import sys
from pathlib import Path

import httpx
import structlog

logger = structlog.get_logger()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

MIGRATION_FILE = Path(__file__).parent.parent / "backend" / "database" / "migrations" / "033_graph_relationships_add_mandato.sql"


def split_sql_statements(sql: str) -> list[str]:
    """Split SQL respecting $$ delimited PL/pgSQL blocks."""
    statements: list[str] = []
    current: list[str] = []
    in_dollar_block = False

    for line in sql.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("--"):
            current.append(line)
            continue

        if line.count("$$") % 2 == 1:
            in_dollar_block = not in_dollar_block

        current.append(line)

        if not in_dollar_block and stripped.endswith(";"):
            stmt = "\n".join(current).strip()
            if stmt and not all(
                sql_line.strip().startswith("--") or not sql_line.strip()
                for sql_line in current
            ):
                statements.append(stmt)
            current = []

    if current:
        stmt = "\n".join(current).strip()
        if stmt and not all(
            sql_line.strip().startswith("--") or not sql_line.strip()
            for sql_line in current
        ):
            statements.append(stmt)

    return statements


def execute_sql_via_supabase(sql: str) -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        logger.error("missing_env", msg="SUPABASE_URL and SUPABASE_SERVICE_KEY required")
        sys.exit(1)

    response = httpx.post(
        f"{SUPABASE_URL}/pg/query",
        json={"query": sql},
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_KEY,
        },
        timeout=60,
    )

    if response.status_code >= 400:
        logger.error("sql_error", status=response.status_code, body=response.text[:500])
        return {"error": response.text}

    return response.json() if response.text else {}


def main() -> None:
    if not MIGRATION_FILE.exists():
        logger.error("migration_not_found", path=str(MIGRATION_FILE))
        sys.exit(1)

    statements = split_sql_statements(MIGRATION_FILE.read_text())
    logger.info("migration_start", file=MIGRATION_FILE.name, statements=len(statements))

    for i, stmt in enumerate(statements, 1):
        logger.info("executing_statement", index=i, preview=stmt[:100])
        result = execute_sql_via_supabase(stmt + ";")
        if "error" in result:
            logger.error("statement_failed", index=i, error=result["error"][:300])
        else:
            logger.info("statement_ok", index=i)

    logger.info("migration_complete", file=MIGRATION_FILE.name)


if __name__ == "__main__":
    main()
