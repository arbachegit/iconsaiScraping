-- Migration 029: Enhanced Audit Logging
-- FASE 7: Governance & Security
-- Date: 2026-03-03
-- Description: Enhanced audit trail with tenant context, data classification, entity tracking, and state diffing

-- ============================================================================
-- ALTER: Add governance columns to existing audit_logs table
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs' AND table_schema = 'public') THEN

        -- Add tenant context
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'tenant_id') THEN
            ALTER TABLE audit_logs ADD COLUMN tenant_id UUID REFERENCES tenants(id);
        END IF;

        -- Add data classification context
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'data_classification') THEN
            ALTER TABLE audit_logs ADD COLUMN data_classification TEXT;
        END IF;

        -- Add affected entity tracking
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'affected_entity_type') THEN
            ALTER TABLE audit_logs ADD COLUMN affected_entity_type TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'affected_entity_id') THEN
            ALTER TABLE audit_logs ADD COLUMN affected_entity_id TEXT;
        END IF;

        -- Add state tracking (before/after snapshots for forensic audit)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'previous_state') THEN
            ALTER TABLE audit_logs ADD COLUMN previous_state JSONB;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'new_state') THEN
            ALTER TABLE audit_logs ADD COLUMN new_state JSONB;
        END IF;

        -- New indexes for governance queries
        CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(affected_entity_type, affected_entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_classification ON audit_logs(data_classification);

    END IF;
END $$;

-- ============================================================================
-- TABLE: audit_logs (created fresh if it does not already exist)
-- Purpose: Comprehensive audit trail for all system actions with governance context
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Actor context
    user_id UUID,
    user_email TEXT,
    -- Action context
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    details JSONB DEFAULT '{}',
    -- Request context
    ip_address TEXT,
    user_agent TEXT,
    -- Governance context (FASE 7)
    tenant_id UUID REFERENCES tenants(id),
    data_classification TEXT,
    -- Entity tracking (FASE 7)
    affected_entity_type TEXT,
    affected_entity_id TEXT,
    -- State tracking (FASE 7)
    previous_state JSONB,
    new_state JSONB,
    -- Timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- TABLE COMMENTS
-- ============================================================================

COMMENT ON TABLE audit_logs IS 'Enhanced audit trail logging all system actions with tenant context, data classification, entity tracking, and state snapshots (FASE 7 Governance)';
COMMENT ON COLUMN audit_logs.id IS 'Unique audit log entry identifier (UUID v4)';
COMMENT ON COLUMN audit_logs.user_id IS 'UUID of the user who performed the action (NULL for system/anonymous actions)';
COMMENT ON COLUMN audit_logs.user_email IS 'Email of the user at time of action (denormalized for audit immutability)';
COMMENT ON COLUMN audit_logs.action IS 'Action performed: create, read, update, delete, export, login, logout, search, approve, reject';
COMMENT ON COLUMN audit_logs.resource IS 'Resource type affected: empresas, pessoas, politicos, mandatos, emendas, noticias, graph, admin, auth';
COMMENT ON COLUMN audit_logs.details IS 'JSONB with additional action-specific details (query params, filters, counts, etc.)';
COMMENT ON COLUMN audit_logs.ip_address IS 'Client IP address at time of request (for security forensics)';
COMMENT ON COLUMN audit_logs.user_agent IS 'Client User-Agent header (browser/API client identification)';
COMMENT ON COLUMN audit_logs.tenant_id IS 'FK to tenants.id - tenant context for multi-tenant audit isolation';
COMMENT ON COLUMN audit_logs.data_classification IS 'Highest data classification level accessed in this action: public, internal, confidential, restricted';
COMMENT ON COLUMN audit_logs.affected_entity_type IS 'Type of entity affected by this action (e.g., dim_empresas, dim_pessoas)';
COMMENT ON COLUMN audit_logs.affected_entity_id IS 'ID of the specific entity affected (stored as TEXT for flexibility across UUID/integer PKs)';
COMMENT ON COLUMN audit_logs.previous_state IS 'JSONB snapshot of entity state BEFORE the action (for update/delete forensics)';
COMMENT ON COLUMN audit_logs.new_state IS 'JSONB snapshot of entity state AFTER the action (for create/update forensics)';
COMMENT ON COLUMN audit_logs.created_at IS 'Immutable timestamp when this audit entry was recorded';

-- ============================================================================
-- INDEXES (created if not already present from ALTER block above)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(affected_entity_type, affected_entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_classification ON audit_logs(data_classification);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource, created_at DESC);

COMMENT ON INDEX idx_audit_user IS 'Fast lookup of all actions performed by a specific user (user activity report)';
COMMENT ON INDEX idx_audit_action IS 'Supports filtering by action type with time ordering (e.g., all deletes in last 24h)';
COMMENT ON INDEX idx_audit_created IS 'Supports time-range queries for audit review and compliance reporting';
COMMENT ON INDEX idx_audit_tenant IS 'Enables tenant-scoped audit queries for multi-tenant isolation';
COMMENT ON INDEX idx_audit_entity IS 'Enables full audit history lookup for a specific entity (e.g., all changes to empresa X)';
COMMENT ON INDEX idx_audit_classification IS 'Supports compliance queries filtering by data sensitivity level';
COMMENT ON INDEX idx_audit_resource IS 'Supports filtering by resource type with time ordering (e.g., all empresa actions today)';

-- ============================================================================
-- FUNCTION: log_audit_event()
-- Purpose: Helper to insert audit entries with automatic classification lookup
-- ============================================================================

CREATE OR REPLACE FUNCTION log_audit_event(
    p_user_id UUID,
    p_user_email TEXT,
    p_action TEXT,
    p_resource TEXT,
    p_details JSONB DEFAULT '{}',
    p_ip_address TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_affected_entity_type TEXT DEFAULT NULL,
    p_affected_entity_id TEXT DEFAULT NULL,
    p_previous_state JSONB DEFAULT NULL,
    p_new_state JSONB DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_tenant_id UUID;
    v_classification TEXT;
    v_audit_id UUID;
BEGIN
    -- Get tenant from session context
    v_tenant_id := get_current_tenant_id();

    -- Get highest classification for the affected resource
    SELECT MAX(dc.classification)
    INTO v_classification
    FROM data_classification dc
    WHERE dc.table_name = p_affected_entity_type
      AND dc.contains_pii = true;

    -- If no PII found, default to 'internal'
    IF v_classification IS NULL THEN
        v_classification := 'internal';
    END IF;

    INSERT INTO audit_logs (
        user_id, user_email, action, resource, details,
        ip_address, user_agent, tenant_id, data_classification,
        affected_entity_type, affected_entity_id,
        previous_state, new_state
    ) VALUES (
        p_user_id, p_user_email, p_action, p_resource, p_details,
        p_ip_address, p_user_agent, v_tenant_id, v_classification,
        p_affected_entity_type, p_affected_entity_id,
        p_previous_state, p_new_state
    ) RETURNING id INTO v_audit_id;

    RETURN v_audit_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION log_audit_event(UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) IS 'Inserts an audit log entry with automatic tenant detection and data classification lookup - primary entry point for all audit logging';
