-- =============================================
-- Migration 024: Event Pipeline (FASE 4 - Data Lake)
-- Data: 2026-03-03
-- Descrição: Pipeline de eventos via Postgres LISTEN/NOTIFY
--            para coleta contínua e processamento assíncrono
-- =============================================

-- ===========================================
-- 1. PIPELINE EVENTS TABLE
-- ===========================================

CREATE TABLE IF NOT EXISTS pipeline_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type TEXT NOT NULL,              -- e.g. 'company.created', 'person.created', 'news.created'
    entity_type TEXT NOT NULL,             -- 'empresa', 'pessoa', 'noticia'
    entity_id TEXT NOT NULL,               -- ID of the affected entity
    payload JSONB DEFAULT '{}',            -- Additional event data
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- ===========================================
-- 2. INDEXES
-- ===========================================

-- Partial index for pending/processing events (hot path)
CREATE INDEX IF NOT EXISTS idx_pipeline_events_status
    ON pipeline_events(status)
    WHERE status IN ('pending', 'processing');

-- Lookup by entity
CREATE INDEX IF NOT EXISTS idx_pipeline_events_entity
    ON pipeline_events(entity_type, entity_id);

-- Chronological listing
CREATE INDEX IF NOT EXISTS idx_pipeline_events_created
    ON pipeline_events(created_at DESC);

-- ===========================================
-- 3. TRIGGER FUNCTION: emit_pipeline_event()
-- ===========================================

CREATE OR REPLACE FUNCTION emit_pipeline_event()
RETURNS TRIGGER AS $$
DECLARE
    v_entity_type TEXT;
    v_event_type TEXT;
BEGIN
    -- Determine entity type from table name
    v_entity_type := CASE TG_TABLE_NAME
        WHEN 'dim_empresas' THEN 'empresa'
        WHEN 'dim_pessoas' THEN 'pessoa'
        WHEN 'dim_noticias' THEN 'noticia'
        ELSE TG_TABLE_NAME
    END;

    v_event_type := v_entity_type || '.created';

    -- Insert event into pipeline
    INSERT INTO pipeline_events (event_type, entity_type, entity_id, payload)
    VALUES (v_event_type, v_entity_type, NEW.id::TEXT, jsonb_build_object('table', TG_TABLE_NAME));

    -- Notify listeners via LISTEN/NOTIFY channel
    PERFORM pg_notify('pipeline_events', json_build_object(
        'event_type', v_event_type,
        'entity_type', v_entity_type,
        'entity_id', NEW.id::TEXT
    )::text);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================
-- 4. ATTACH TRIGGERS TO DIMENSION TABLES
-- ===========================================

-- Drop existing triggers if re-running migration
DROP TRIGGER IF EXISTS trg_empresas_pipeline ON dim_empresas;
DROP TRIGGER IF EXISTS trg_pessoas_pipeline ON dim_pessoas;
DROP TRIGGER IF EXISTS trg_noticias_pipeline ON dim_noticias;

-- Empresas: emit event on new company insert
CREATE TRIGGER trg_empresas_pipeline
    AFTER INSERT ON dim_empresas
    FOR EACH ROW
    EXECUTE FUNCTION emit_pipeline_event();

-- Pessoas: emit event on new person insert
CREATE TRIGGER trg_pessoas_pipeline
    AFTER INSERT ON dim_pessoas
    FOR EACH ROW
    EXECUTE FUNCTION emit_pipeline_event();

-- Notícias: emit event on new news insert
CREATE TRIGGER trg_noticias_pipeline
    AFTER INSERT ON dim_noticias
    FOR EACH ROW
    EXECUTE FUNCTION emit_pipeline_event();

-- ===========================================
-- 5. COMMENTS
-- ===========================================

-- Table
COMMENT ON TABLE pipeline_events IS 'Event pipeline for async processing via LISTEN/NOTIFY pattern (FASE 4 - Data Lake)';
COMMENT ON COLUMN pipeline_events.id IS 'Unique event identifier (UUID v4)';
COMMENT ON COLUMN pipeline_events.event_type IS 'Qualified event name (e.g. empresa.created, pessoa.created, noticia.created)';
COMMENT ON COLUMN pipeline_events.entity_type IS 'Source entity type: empresa, pessoa, noticia';
COMMENT ON COLUMN pipeline_events.entity_id IS 'UUID of the entity that triggered the event (as TEXT for flexibility)';
COMMENT ON COLUMN pipeline_events.payload IS 'Additional JSONB data attached to the event (source table, metadata)';
COMMENT ON COLUMN pipeline_events.status IS 'Processing status: pending → processing → completed/failed';
COMMENT ON COLUMN pipeline_events.retry_count IS 'Number of processing retries attempted (max defined by consumer)';
COMMENT ON COLUMN pipeline_events.error_message IS 'Error details when status is failed';
COMMENT ON COLUMN pipeline_events.created_at IS 'Timestamp when event was emitted';
COMMENT ON COLUMN pipeline_events.processed_at IS 'Timestamp when a consumer picked up the event';
COMMENT ON COLUMN pipeline_events.completed_at IS 'Timestamp when processing finished (success or final failure)';

-- Indexes
COMMENT ON INDEX idx_pipeline_events_status IS 'Partial index on pending/processing events for fast consumer polling';
COMMENT ON INDEX idx_pipeline_events_entity IS 'Lookup events by entity type and ID for event history';
COMMENT ON INDEX idx_pipeline_events_created IS 'Chronological index for event listing and monitoring';

-- Function
COMMENT ON FUNCTION emit_pipeline_event() IS 'Trigger function that inserts a pipeline_event row and sends pg_notify on entity INSERT';

-- Triggers
COMMENT ON TRIGGER trg_empresas_pipeline ON dim_empresas IS 'Emits empresa.created event when a new company is inserted';
COMMENT ON TRIGGER trg_pessoas_pipeline ON dim_pessoas IS 'Emits pessoa.created event when a new person is inserted';
COMMENT ON TRIGGER trg_noticias_pipeline ON dim_noticias IS 'Emits noticia.created event when a new news article is inserted';
