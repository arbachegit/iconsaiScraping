-- Migration 027: Multi-Tenant Support
-- FASE 7: Governance & Security
-- Date: 2026-03-03
-- Description: Multi-tenant isolation with RLS-ready policies

-- ============================================================================
-- TABLE: tenants
-- Purpose: Organization/tenant registry for multi-tenant isolation
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    domain TEXT,
    settings JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenants IS 'Multi-tenant organization registry - each tenant is an isolated data partition (FASE 7 Governance)';
COMMENT ON COLUMN tenants.id IS 'Unique tenant identifier (UUID v4)';
COMMENT ON COLUMN tenants.name IS 'Display name of the tenant/organization';
COMMENT ON COLUMN tenants.slug IS 'URL-safe unique identifier used in routing and API context';
COMMENT ON COLUMN tenants.domain IS 'Custom domain associated with this tenant (optional)';
COMMENT ON COLUMN tenants.settings IS 'Tenant-specific configuration as JSONB (plan, max_users, features, etc.)';
COMMENT ON COLUMN tenants.is_active IS 'Whether this tenant is active - inactive tenants cannot authenticate';
COMMENT ON COLUMN tenants.created_at IS 'Timestamp when the tenant was created';
COMMENT ON COLUMN tenants.updated_at IS 'Timestamp of last tenant record update';

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(id) WHERE is_active = true;

COMMENT ON INDEX idx_tenants_slug IS 'Fast lookup by slug for API routing and authentication context';
COMMENT ON INDEX idx_tenants_active IS 'Partial index on active tenants only - reduces scan size for auth checks';

-- ============================================================================
-- ALTER: Add tenant_id to users table (if it exists)
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users' AND table_schema = 'public') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'tenant_id') THEN
            ALTER TABLE users ADD COLUMN tenant_id UUID REFERENCES tenants(id);
            CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

            COMMENT ON COLUMN users.tenant_id IS 'FK to tenants.id - associates user with their organization';
        END IF;
    END IF;
END $$;

-- Comment on users.tenant_id index (outside DO block since index may or may not exist)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_users_tenant') THEN
        COMMENT ON INDEX idx_users_tenant IS 'Enables fast user filtering by tenant for multi-tenant queries';
    END IF;
END $$;

-- ============================================================================
-- SEED: Default tenant
-- ============================================================================

INSERT INTO tenants (name, slug, domain, settings)
VALUES ('IconsAI', 'iconsai', 'iconsai.ai', '{"plan": "enterprise", "max_users": 100}')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- FUNCTION: get_current_tenant_id()
-- Purpose: Retrieves the current tenant from session settings (for RLS policies)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_current_tenant_id()
RETURNS UUID AS $$
BEGIN
    RETURN current_setting('app.current_tenant_id', true)::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_current_tenant_id() IS 'Returns current tenant UUID from session setting app.current_tenant_id - used by RLS policies for tenant isolation';

-- ============================================================================
-- RLS POLICIES (commented out for progressive rollout)
-- Uncomment when ready to enforce multi-tenancy per table
-- ============================================================================

-- Step 1: First add tenant_id column to target tables:
-- ALTER TABLE dim_empresas ADD COLUMN tenant_id UUID REFERENCES tenants(id);
-- ALTER TABLE dim_pessoas ADD COLUMN tenant_id UUID REFERENCES tenants(id);

-- Step 2: Backfill existing data with default tenant:
-- UPDATE dim_empresas SET tenant_id = (SELECT id FROM tenants WHERE slug = 'iconsai');
-- UPDATE dim_pessoas SET tenant_id = (SELECT id FROM tenants WHERE slug = 'iconsai');

-- Step 3: Enable RLS and create policies:
-- ALTER TABLE dim_empresas ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_empresas ON dim_empresas USING (tenant_id = get_current_tenant_id());

-- ALTER TABLE dim_pessoas ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_pessoas ON dim_pessoas USING (tenant_id = get_current_tenant_id());

-- Step 4: Set tenant context in application middleware:
-- SET app.current_tenant_id = '<tenant-uuid>';
