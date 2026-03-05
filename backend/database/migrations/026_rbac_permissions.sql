-- Migration 026: Granular RBAC Permissions
-- FASE 7: Governance & Security
-- Date: 2026-03-03
-- Description: Extended RBAC with granular module+action permissions

-- ============================================================================
-- TABLE: rbac_permissions
-- Purpose: Defines granular permission entries per module and action
-- ============================================================================

CREATE TABLE IF NOT EXISTS rbac_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    module TEXT NOT NULL,           -- 'empresas', 'pessoas', 'politicos', 'mandatos', 'emendas', 'noticias', 'graph', 'admin', 'intelligence'
    action TEXT NOT NULL,           -- 'read', 'write', 'delete', 'export', 'approve'
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_rbac_perm UNIQUE(module, action)
);

COMMENT ON TABLE rbac_permissions IS 'Granular permission definitions mapping modules to allowed actions (FASE 7 Governance)';
COMMENT ON COLUMN rbac_permissions.id IS 'Unique permission identifier (UUID v4)';
COMMENT ON COLUMN rbac_permissions.module IS 'System module name: empresas, pessoas, politicos, mandatos, emendas, noticias, graph, admin, intelligence';
COMMENT ON COLUMN rbac_permissions.action IS 'Allowed action type: read, write, delete, export, approve';
COMMENT ON COLUMN rbac_permissions.description IS 'Human-readable description of what this permission grants';
COMMENT ON COLUMN rbac_permissions.created_at IS 'Timestamp when this permission was created';
COMMENT ON CONSTRAINT uk_rbac_perm ON rbac_permissions IS 'Ensures each module+action combination is unique';

-- ============================================================================
-- TABLE: rbac_role_permissions
-- Purpose: Maps roles to their granted permissions (many-to-many)
-- ============================================================================

CREATE TABLE IF NOT EXISTS rbac_role_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role TEXT NOT NULL,             -- 'superadmin', 'admin', 'user', 'viewer'
    permission_id UUID NOT NULL REFERENCES rbac_permissions(id) ON DELETE CASCADE,
    granted_by UUID,               -- User who granted
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_role_perm UNIQUE(role, permission_id)
);

COMMENT ON TABLE rbac_role_permissions IS 'Role-to-permission mapping table enabling granular RBAC (FASE 7 Governance)';
COMMENT ON COLUMN rbac_role_permissions.id IS 'Unique role-permission mapping identifier (UUID v4)';
COMMENT ON COLUMN rbac_role_permissions.role IS 'Role name: superadmin, admin, user, viewer';
COMMENT ON COLUMN rbac_role_permissions.permission_id IS 'FK to rbac_permissions.id - the permission being granted';
COMMENT ON COLUMN rbac_role_permissions.granted_by IS 'UUID of the user who granted this permission (audit trail)';
COMMENT ON COLUMN rbac_role_permissions.granted_at IS 'Timestamp when this permission was granted to the role';
COMMENT ON CONSTRAINT uk_role_perm ON rbac_role_permissions IS 'Prevents duplicate role+permission assignments';

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_rbac_role_perms_role ON rbac_role_permissions(role);
CREATE INDEX IF NOT EXISTS idx_rbac_perms_module ON rbac_permissions(module);

COMMENT ON INDEX idx_rbac_role_perms_role IS 'Speeds up permission lookups by role (used on every auth check)';
COMMENT ON INDEX idx_rbac_perms_module IS 'Speeds up permission lookups by module for admin management UI';

-- ============================================================================
-- SEED: Default permissions for all modules x actions
-- ============================================================================

INSERT INTO rbac_permissions (module, action, description) VALUES
    -- Empresas module
    ('empresas', 'read', 'View company data'),
    ('empresas', 'write', 'Create/edit companies'),
    ('empresas', 'delete', 'Delete companies'),
    ('empresas', 'export', 'Export company data'),
    ('empresas', 'approve', 'Approve company records'),
    -- Pessoas module
    ('pessoas', 'read', 'View people data'),
    ('pessoas', 'write', 'Create/edit people'),
    ('pessoas', 'delete', 'Delete people'),
    ('pessoas', 'export', 'Export people data'),
    -- Politicos module
    ('politicos', 'read', 'View politician data'),
    ('politicos', 'export', 'Export politician data'),
    -- Mandatos module
    ('mandatos', 'read', 'View mandate data'),
    ('mandatos', 'export', 'Export mandate data'),
    -- Emendas module
    ('emendas', 'read', 'View amendment data'),
    ('emendas', 'export', 'Export amendment data'),
    -- Noticias module
    ('noticias', 'read', 'View news data'),
    ('noticias', 'write', 'Create/edit news'),
    ('noticias', 'delete', 'Delete news'),
    ('noticias', 'export', 'Export news data'),
    -- Graph module
    ('graph', 'read', 'View graph visualization'),
    ('graph', 'write', 'Edit graph relationships'),
    ('graph', 'export', 'Export graph data'),
    -- Intelligence module
    ('intelligence', 'read', 'Use intelligence queries'),
    ('intelligence', 'write', 'Configure intelligence settings'),
    -- Admin module
    ('admin', 'read', 'View admin panel'),
    ('admin', 'write', 'Manage users and settings'),
    ('admin', 'delete', 'Delete users')
ON CONFLICT (module, action) DO NOTHING;

-- ============================================================================
-- SEED: Role permission grants
-- ============================================================================

-- Superadmin: ALL permissions
INSERT INTO rbac_role_permissions (role, permission_id)
SELECT 'superadmin', id FROM rbac_permissions
ON CONFLICT (role, permission_id) DO NOTHING;

-- User: read + export only
INSERT INTO rbac_role_permissions (role, permission_id)
SELECT 'user', id FROM rbac_permissions WHERE action IN ('read', 'export')
ON CONFLICT (role, permission_id) DO NOTHING;

-- Admin: all except admin module (except admin read)
INSERT INTO rbac_role_permissions (role, permission_id)
SELECT 'admin', id FROM rbac_permissions WHERE module != 'admin' OR action = 'read'
ON CONFLICT (role, permission_id) DO NOTHING;

-- Viewer: read only (no export)
INSERT INTO rbac_role_permissions (role, permission_id)
SELECT 'viewer', id FROM rbac_permissions WHERE action = 'read'
ON CONFLICT (role, permission_id) DO NOTHING;
