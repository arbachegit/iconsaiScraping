-- Migration 018: Add role column to users table
-- Roles: superadmin, admin, user
-- Replaces binary is_admin with granular role system
--
-- SuperAdmin: full access, create/delete admins+users, edit any user, can't be deleted
-- Admin: send invites (create Users), all module access, no edit/delete capabilities
-- User: permissions-controlled module access, no /admin access

-- 1. Add role column with default 'user'
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';

-- 2. Add CHECK constraint for valid roles
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('superadmin', 'admin', 'user'));
    END IF;
END $$;

-- 3. Backfill: existing is_admin=true users become superadmin
UPDATE users SET role = 'superadmin' WHERE is_admin = true AND (role IS NULL OR role = 'user');

-- 4. Backfill: non-admin users stay as 'user'
UPDATE users SET role = 'user' WHERE is_admin = false AND role IS NULL;

-- 5. Index for role queries
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 6. Ensure NOT NULL after backfill
ALTER TABLE users ALTER COLUMN role SET NOT NULL;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';
