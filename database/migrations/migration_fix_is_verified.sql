-- =============================================================
-- Migration: Fix is_verified for existing users
-- Date: 2026-02-26
-- Description: Ensure admin users and existing active users
--              with passwords have is_verified = true so they
--              can log in after the is_verified check was added.
-- =============================================================

-- 1. Ensure is_verified column exists (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;

-- 2. Admin users must be verified
UPDATE users SET is_verified = true WHERE is_admin = true;

-- 3. Existing active users with a real password are verified
--    (password_hash not empty means they already set their password)
UPDATE users SET is_verified = true
WHERE is_active = true
  AND password_hash IS NOT NULL
  AND password_hash != '';
