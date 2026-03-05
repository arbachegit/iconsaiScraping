-- =============================================
-- Migration 025: Data Retention Policies (FASE 4 - Data Lake)
-- Data: 2026-03-03
-- Descrição: Raw API response archival (data lake staging)
--            and automated cleanup functions for retention
-- =============================================

-- ===========================================
-- 1. RAW API RESPONSES TABLE (Partitioned)
-- ===========================================

CREATE TABLE IF NOT EXISTS raw_api_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source TEXT NOT NULL,                  -- 'brasilapi', 'serper', 'perplexity', 'apollo', 'cnpja'
    endpoint TEXT NOT NULL,                -- API endpoint called
    request_params JSONB DEFAULT '{}',     -- Request parameters (sanitized, no secrets)
    response_body JSONB NOT NULL,          -- Full API response
    http_status INTEGER,
    response_time_ms INTEGER,
    entity_type TEXT,                      -- Related entity type (empresa, pessoa, noticia)
    entity_id TEXT,                        -- Related entity ID
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Default partition catches all rows not matched by explicit partitions
CREATE TABLE IF NOT EXISTS raw_api_responses_default
    PARTITION OF raw_api_responses DEFAULT;

-- ===========================================
-- 2. INDEXES
-- ===========================================

-- Lookup by source + time for analytics/debugging
CREATE INDEX IF NOT EXISTS idx_raw_api_source
    ON raw_api_responses(source, created_at DESC);

-- Lookup by related entity for traceability
CREATE INDEX IF NOT EXISTS idx_raw_api_entity
    ON raw_api_responses(entity_type, entity_id);

-- ===========================================
-- 3. CLEANUP FUNCTIONS
-- ===========================================

-- Clean completed pipeline events older than 30 days
-- and all pipeline events older than 90 days regardless of status
CREATE OR REPLACE FUNCTION cleanup_old_pipeline_events()
RETURNS void AS $$
BEGIN
    DELETE FROM pipeline_events
    WHERE completed_at < NOW() - INTERVAL '30 days'
      AND status = 'completed';

    DELETE FROM pipeline_events
    WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Clean raw API responses older than 90 days
CREATE OR REPLACE FUNCTION cleanup_old_raw_responses()
RETURNS void AS $$
BEGIN
    DELETE FROM raw_api_responses
    WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- ===========================================
-- 4. COMMENTS
-- ===========================================

-- Table
COMMENT ON TABLE raw_api_responses IS 'Raw API response archive for data lake staging and compliance traceability (90-day retention)';
COMMENT ON COLUMN raw_api_responses.id IS 'Unique response identifier (UUID v4)';
COMMENT ON COLUMN raw_api_responses.source IS 'API source name: brasilapi, serper, perplexity, apollo, cnpja';
COMMENT ON COLUMN raw_api_responses.endpoint IS 'Full API endpoint path that was called';
COMMENT ON COLUMN raw_api_responses.request_params IS 'Sanitized request parameters (NEVER store API keys or secrets)';
COMMENT ON COLUMN raw_api_responses.response_body IS 'Complete API response body as JSONB';
COMMENT ON COLUMN raw_api_responses.http_status IS 'HTTP status code returned by the API';
COMMENT ON COLUMN raw_api_responses.response_time_ms IS 'Response latency in milliseconds for performance monitoring';
COMMENT ON COLUMN raw_api_responses.entity_type IS 'Related entity type for cross-referencing (empresa, pessoa, noticia)';
COMMENT ON COLUMN raw_api_responses.entity_id IS 'Related entity UUID for cross-referencing with dimension tables';
COMMENT ON COLUMN raw_api_responses.created_at IS 'Timestamp when the API response was archived (partition key)';

-- Indexes
COMMENT ON INDEX idx_raw_api_source IS 'Source + time index for filtering responses by API provider and date range';
COMMENT ON INDEX idx_raw_api_entity IS 'Entity lookup index for tracing all API calls related to a specific entity';

-- Functions
COMMENT ON FUNCTION cleanup_old_pipeline_events() IS 'Retention policy: deletes completed events after 30 days, all events after 90 days';
COMMENT ON FUNCTION cleanup_old_raw_responses() IS 'Retention policy: deletes raw API responses older than 90 days';
