"""
Apply BI Pipeline migrations (037-047).

Creates all tables for the Business Intelligence pipeline:
- fato_evidencias (centralized evidence)
- dim_contextos + fato_empresa_contexto (analytical contexts)
- dim_taxonomia_empresa (taxonomy with BR sectors/segments)
- fato_website_crawl (Gemini crawl results)
- dim_ecossistema_empresas (ecosystem relationships)
- dim_produtos (products/services)
- dim_contatos_website (website contacts)
- dim_datas_comemorativas (commemorative dates)
- fato_perfil_geografico (geographic profile)
- fato_perfil_cnae (CNAE profile)
- fato_perfil_tributario (tax profile)
- fato_oportunidades (opportunities + lead scoring)
- Temporal tracking on fato_relacoes_entidades

Usage:
    python scripts/apply_migration_bi_pipeline.py
"""

import os
import sys
from pathlib import Path

import httpx
import structlog

logger = structlog.get_logger()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

MIGRATIONS_DIR = Path(__file__).parent.parent / "backend" / "database" / "migrations"

MIGRATION_FILES = [
    "037_fato_evidencias.sql",
    "038_dim_contextos.sql",
    "039_dim_taxonomia_empresa.sql",
    "040_fato_website_crawl.sql",
    "041_dim_ecossistema_empresas.sql",
    "042_dim_produtos.sql",
    "043_dim_contatos_website.sql",
    "044_dim_datas_comemorativas.sql",
    "045_perfis_geo_cnae_tributario.sql",
    "046_fato_oportunidades.sql",
    "047_relacoes_temporal_tracking.sql",
]


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

    response = httpx.post(url, json={"query": sql}, headers=headers, timeout=60)

    if response.status_code >= 400:
        logger.error("sql_error", status=response.status_code, body=response.text[:500])
        return {"error": response.text}

    return response.json() if response.text else {}


def split_sql_statements(sql: str) -> list[str]:
    """Split SQL respecting $$ delimited PL/pgSQL blocks and multi-line INSERTs."""
    statements = []
    current = []
    in_dollar_block = False

    for line in sql.split("\n"):
        stripped = line.strip()

        # Skip pure comment lines (but keep inline comments within statements)
        if stripped.startswith("--") and not current:
            continue

        # Track $$ blocks
        dollar_count = stripped.count("$$")
        if dollar_count % 2 == 1:
            in_dollar_block = not in_dollar_block

        current.append(line)

        # Split on ; only when NOT in a $$ block
        if not in_dollar_block and stripped.endswith(";"):
            stmt = "\n".join(current).strip()
            if stmt and not all(line.strip().startswith("--") for line in current if line.strip()):
                statements.append(stmt)
            current = []

    # Handle trailing statement without semicolon
    if current:
        stmt = "\n".join(current).strip()
        if stmt and not stmt.startswith("--"):
            statements.append(stmt)

    return statements


def apply_migration(filename: str) -> tuple[int, int]:
    """Apply a single migration file. Returns (success_count, error_count)."""
    filepath = MIGRATIONS_DIR / filename
    if not filepath.exists():
        logger.error("migration_not_found", file=filename)
        return 0, 1

    sql = filepath.read_text()
    statements = split_sql_statements(sql)

    logger.info("migration_start", file=filename, statements=len(statements))

    success = 0
    errors = 0

    for i, stmt in enumerate(statements, 1):
        if not stmt.strip():
            continue

        preview = stmt[:100].replace("\n", " ")
        logger.info("executing", file=filename, index=i, preview=preview)

        result = execute_sql_via_supabase(stmt if stmt.endswith(";") else stmt + ";")

        if "error" in result:
            # Check if it's a "already exists" type error (safe to ignore)
            error_text = str(result["error"])
            if "already exists" in error_text or "duplicate" in error_text.lower():
                logger.info("already_exists_skipped", file=filename, index=i)
                success += 1
            else:
                logger.error("statement_failed", file=filename, index=i, error=error_text[:300])
                errors += 1
        else:
            logger.info("statement_ok", file=filename, index=i)
            success += 1

    return success, errors


def main() -> None:
    logger.info("bi_pipeline_migration_start", total_files=len(MIGRATION_FILES))

    total_success = 0
    total_errors = 0

    for filename in MIGRATION_FILES:
        s, e = apply_migration(filename)
        total_success += s
        total_errors += e

    # Apply unique constraints for upsert support
    logger.info("applying_unique_constraints")
    constraints = [
        "ALTER TABLE fato_perfil_cnae ADD CONSTRAINT IF NOT EXISTS uq_perfil_cnae_empresa UNIQUE (empresa_id);",
        "ALTER TABLE fato_perfil_tributario ADD CONSTRAINT IF NOT EXISTS uq_perfil_trib_empresa UNIQUE (empresa_id);",
        "ALTER TABLE fato_perfil_geografico ADD CONSTRAINT IF NOT EXISTS uq_perfil_geo_empresa UNIQUE (empresa_id);",
    ]

    for sql in constraints:
        result = execute_sql_via_supabase(sql)
        if "error" in result:
            error_text = str(result["error"])
            if "already exists" in error_text:
                logger.info("constraint_exists", sql=sql[:60])
            else:
                logger.warn("constraint_error", sql=sql[:60], error=error_text[:200])

    logger.info(
        "bi_pipeline_migration_complete",
        total_success=total_success,
        total_errors=total_errors,
        status="OK" if total_errors == 0 else "PARTIAL",
    )

    if total_errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
