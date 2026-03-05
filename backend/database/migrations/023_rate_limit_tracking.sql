-- =============================================
-- Migration 023: Rate Limit Tracking
-- Data: 2026-03-03
-- Descrição: Per-user rate limiting with role-based thresholds
-- =============================================

-- ===========================================
-- 1. RATE LIMIT TRACKING TABLE
-- ===========================================

CREATE TABLE IF NOT EXISTS rate_limit_tracking (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    user_role TEXT NOT NULL DEFAULT 'user',
    endpoint TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_end TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===========================================
-- 2. INDEXES
-- ===========================================

-- Fast lookup by user + endpoint + window
CREATE INDEX IF NOT EXISTS idx_rate_limit_user_endpoint ON rate_limit_tracking(user_id, endpoint, window_start);

-- Cleanup expired windows
CREATE INDEX IF NOT EXISTS idx_rate_limit_cleanup ON rate_limit_tracking(window_end);

-- ===========================================
-- 3. CLEANUP FUNCTION
-- ===========================================

-- Auto-cleanup expired windows (keep last 24h)
CREATE OR REPLACE FUNCTION cleanup_expired_rate_limits()
RETURNS void AS $$
BEGIN
    DELETE FROM rate_limit_tracking WHERE window_end < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- ===========================================
-- COMMENTS
-- ===========================================

COMMENT ON TABLE rate_limit_tracking IS 'Per-user rate limit tracking for API endpoints';
COMMENT ON COLUMN rate_limit_tracking.user_id IS 'UUID of the authenticated user';
COMMENT ON COLUMN rate_limit_tracking.user_role IS 'User role for tiered limits (user, admin, api)';
COMMENT ON COLUMN rate_limit_tracking.endpoint IS 'API endpoint path (e.g. /api/companies/search)';
COMMENT ON COLUMN rate_limit_tracking.request_count IS 'Number of requests in current window';
COMMENT ON COLUMN rate_limit_tracking.window_start IS 'Start of the rate limit window';
COMMENT ON COLUMN rate_limit_tracking.window_end IS 'End of the rate limit window (used for cleanup)';
COMMENT ON INDEX idx_rate_limit_user_endpoint IS 'Fast lookup for rate limit checks by user + endpoint';
COMMENT ON INDEX idx_rate_limit_cleanup IS 'Index for efficient cleanup of expired rate limit windows';
