"""
Consolidated Auth Migration Script.

Creates the users table from scratch and applies ALL auth migrations in order:
1. schema.sql        — base users table + fontes_dados
2. auth_level1       — verification_codes, refresh_tokens, audit_logs
3. auth_level1_fix   — role → is_admin
4. auth_address      — address fields (cep, logradouro, etc.)
5. 017_messaging     — messaging_logs table
6. 018_add_role      — role column (superadmin/admin/user)

Usage:
    python3 scripts/apply_all_auth_migrations.py

Requires: SUPABASE_URL + SUPABASE_SERVICE_KEY in .env
"""

import os
import re
import sys
from pathlib import Path

import structlog
from dotenv import load_dotenv

project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

load_dotenv(project_root / ".env")

logger = structlog.get_logger()


def get_database_url() -> str:
    """Build PostgreSQL connection URL from Supabase env vars."""
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url

    supabase_url = os.getenv("SUPABASE_URL", "")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "")

    if not supabase_url:
        raise ValueError("DATABASE_URL or SUPABASE_URL must be set in .env")

    match = re.match(r"https://([^.]+)\.supabase\.co", supabase_url)
    if not match:
        raise ValueError(f"Cannot parse Supabase URL: {supabase_url}")

    project_ref = match.group(1)
    return f"postgresql://postgres.{project_ref}:{supabase_key}@aws-0-us-west-2.pooler.supabase.com:6543/postgres"


# ============================================================
# All SQL in execution order
# ============================================================

CONSOLIDATED_SQL = """
-- ===========================================
-- STEP 1: Base users table (from schema.sql)
-- ===========================================
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    name VARCHAR(255),
    is_admin BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    is_verified BOOLEAN DEFAULT false,
    cpf_encrypted TEXT,
    phone_encrypted TEXT,
    permissions JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===========================================
-- STEP 2: Auth Level 1 — verification, refresh, audit
-- ===========================================
CREATE TABLE IF NOT EXISTS verification_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('activation', 'password_reset')),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verification_user ON verification_codes(user_id, type);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    resource VARCHAR(200),
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);

-- ===========================================
-- STEP 3: Address fields
-- ===========================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS cep VARCHAR(9);
ALTER TABLE users ADD COLUMN IF NOT EXISTS logradouro VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS numero VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS complemento VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bairro VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cidade VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS uf VARCHAR(2);

-- ===========================================
-- STEP 4: Messaging logs (017)
-- ===========================================
CREATE TABLE IF NOT EXISTS messaging_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('twilio', 'infobip', 'smtp', 'dev')),
    recipient TEXT NOT NULL,
    message_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed', 'fallback')),
    error_message TEXT,
    provider_message_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messaging_user ON messaging_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messaging_status ON messaging_logs(status, created_at DESC);

-- ===========================================
-- STEP 5: Role column (018)
-- ===========================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('superadmin', 'admin', 'user'));
    END IF;
END $$;

UPDATE users SET role = 'superadmin' WHERE is_admin = true AND (role IS NULL OR role = 'user');
UPDATE users SET role = 'user' WHERE is_admin = false AND role IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

ALTER TABLE users ALTER COLUMN role SET NOT NULL;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';

-- ===========================================
-- STEP 6: Useful indexes
-- ===========================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
"""


def apply_migration() -> None:
    """Execute the consolidated SQL."""
    import psycopg2

    database_url = get_database_url()
    print(f"Connecting to database...")

    conn = psycopg2.connect(database_url)
    cur = conn.cursor()

    # Split by semicolons, handle DO $$ blocks specially
    # We'll execute the whole thing as one transaction
    try:
        cur.execute(CONSOLIDATED_SQL)
        conn.commit()
        print("ALL migrations applied successfully!")
    except Exception as e:
        conn.rollback()
        print(f"ERROR: {e}")
        print("\nTrying statement-by-statement...")

        # Fallback: split and run one by one
        # Handle DO $$ blocks by joining them back
        raw_parts = CONSOLIDATED_SQL.split(";")
        statements = []
        i = 0
        while i < len(raw_parts):
            part = raw_parts[i].strip()
            if not part or part.startswith("--"):
                i += 1
                continue
            # If this contains DO $$ but no END $$, merge with next parts
            if "DO $$" in part and "END $$" not in part:
                while i + 1 < len(raw_parts) and "END $$" not in raw_parts[i]:
                    i += 1
                    part += ";" + raw_parts[i]
                statements.append(part)
            else:
                statements.append(part)
            i += 1

        success = 0
        errors = 0
        for idx, stmt in enumerate(statements, 1):
            clean = "\n".join(
                l for l in stmt.split("\n")
                if l.strip() and not l.strip().startswith("--")
            )
            if not clean:
                continue
            try:
                cur.execute(clean)
                conn.commit()
                preview = clean.replace("\n", " ")[:80]
                print(f"  [{idx}] OK: {preview}")
                success += 1
            except Exception as e2:
                conn.rollback()
                preview = clean.replace("\n", " ")[:80]
                print(f"  [{idx}] SKIP: {preview} ({e2})")
                errors += 1

        print(f"\nDone: {success} OK, {errors} skipped")

    # Validate
    try:
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'users'
            ORDER BY ordinal_position
        """)
        columns = [r[0] for r in cur.fetchall()]
        print(f"\nusers table columns ({len(columns)}):")
        for col in columns:
            print(f"  - {col}")
    except Exception as e:
        print(f"Validation error: {e}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    print("=" * 60)
    print("Consolidated Auth Migration - IconsAI Scraping")
    print("Creates users table + all auth migrations")
    print("=" * 60)
    apply_migration()
    print("=" * 60)
