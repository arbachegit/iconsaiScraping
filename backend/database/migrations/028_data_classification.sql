-- Migration 028: Data Classification (LGPD Compliance)
-- FASE 7: Governance & Security
-- Date: 2026-03-03
-- Description: LGPD-compliant data classification registry with PII tracking and anonymization rules

-- ============================================================================
-- TABLE: data_classification
-- Purpose: Classifies every column containing sensitive/personal data per LGPD
-- ============================================================================

CREATE TABLE IF NOT EXISTS data_classification (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    classification TEXT NOT NULL CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
    contains_pii BOOLEAN DEFAULT false,
    pii_type TEXT,                  -- 'cpf', 'email', 'phone', 'address', 'name', 'financial', 'social'
    anonymization_rule TEXT,        -- 'mask_cpf', 'mask_email', 'mask_phone', 'hash', 'redact', 'none'
    legal_basis TEXT,               -- LGPD legal basis (Art. 7)
    retention_days INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_data_class UNIQUE(table_name, column_name)
);

COMMENT ON TABLE data_classification IS 'LGPD-compliant data classification registry - tracks PII, anonymization rules, and legal basis for every sensitive column (FASE 7 Governance)';
COMMENT ON COLUMN data_classification.id IS 'Unique classification entry identifier (UUID v4)';
COMMENT ON COLUMN data_classification.table_name IS 'Name of the database table containing the classified column';
COMMENT ON COLUMN data_classification.column_name IS 'Name of the column being classified';
COMMENT ON COLUMN data_classification.classification IS 'Data sensitivity level: public (open data), internal (business use), confidential (PII), restricted (sensitive PII like CPF)';
COMMENT ON COLUMN data_classification.contains_pii IS 'Whether this column contains Personally Identifiable Information per LGPD definition';
COMMENT ON COLUMN data_classification.pii_type IS 'Type of PII: cpf, email, phone, address, name, financial, social';
COMMENT ON COLUMN data_classification.anonymization_rule IS 'Rule applied when anonymizing data: mask_cpf (***.***.XXX-XX), mask_email (f***@domain), mask_phone ((**) ****-XXXX), hash (SHA-256), redact (full removal), none';
COMMENT ON COLUMN data_classification.legal_basis IS 'LGPD legal basis for processing this data (Art. 7, I-X of Lei 13.709/2018)';
COMMENT ON COLUMN data_classification.retention_days IS 'Maximum number of days this data should be retained (NULL = indefinite per legal basis)';
COMMENT ON COLUMN data_classification.notes IS 'Additional notes about classification decisions or special handling requirements';
COMMENT ON COLUMN data_classification.created_at IS 'Timestamp when this classification was created';
COMMENT ON COLUMN data_classification.updated_at IS 'Timestamp of last classification update';
COMMENT ON CONSTRAINT uk_data_class ON data_classification IS 'Ensures each table+column combination has exactly one classification entry';

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_data_class_table ON data_classification(table_name);
CREATE INDEX IF NOT EXISTS idx_data_class_pii ON data_classification(contains_pii) WHERE contains_pii = true;
CREATE INDEX IF NOT EXISTS idx_data_class_classification ON data_classification(classification);

COMMENT ON INDEX idx_data_class_table IS 'Fast lookup of all classified columns for a given table (used in data export and audit)';
COMMENT ON INDEX idx_data_class_pii IS 'Partial index on PII columns only - enables fast identification of all personal data across the system';
COMMENT ON INDEX idx_data_class_classification IS 'Supports filtering by classification level for compliance reports';

-- ============================================================================
-- CHECK CONSTRAINT documentation
-- ============================================================================

-- Note: The CHECK constraint on classification is inline.
-- Valid values: 'public', 'internal', 'confidential', 'restricted'
-- public     = Open/government data (e.g., CNPJ, razao_social from Receita Federal)
-- internal   = Business data not meant for external sharing
-- confidential = Contains PII requiring consent (e.g., email, phone)
-- restricted = Highly sensitive PII requiring explicit legal basis (e.g., CPF)

-- ============================================================================
-- SEED: Classification for known PII columns in dim_empresas
-- ============================================================================

INSERT INTO data_classification (table_name, column_name, classification, contains_pii, pii_type, anonymization_rule, legal_basis) VALUES
    -- dim_empresas columns
    ('dim_empresas', 'cnpj', 'internal', false, NULL, 'none', 'Dado publico - Receita Federal'),
    ('dim_empresas', 'razao_social', 'internal', false, NULL, 'none', 'Dado publico - Receita Federal'),
    ('dim_empresas', 'nome_fantasia', 'internal', false, NULL, 'none', 'Dado publico - Receita Federal'),
    ('dim_empresas', 'email', 'confidential', true, 'email', 'mask_email', 'Consentimento - Art. 7, I LGPD'),
    ('dim_empresas', 'telefone', 'confidential', true, 'phone', 'mask_phone', 'Consentimento - Art. 7, I LGPD'),
    ('dim_empresas', 'telefone_1', 'confidential', true, 'phone', 'mask_phone', 'Consentimento - Art. 7, I LGPD'),
    ('dim_empresas', 'telefone_2', 'confidential', true, 'phone', 'mask_phone', 'Consentimento - Art. 7, I LGPD'),
    ('dim_empresas', 'endereco', 'confidential', true, 'address', 'redact', 'Consentimento - Art. 7, I LGPD'),
    -- dim_pessoas columns
    ('dim_pessoas', 'cpf', 'restricted', true, 'cpf', 'mask_cpf', 'Cumprimento de obrigacao legal - Art. 7, II LGPD'),
    ('dim_pessoas', 'nome_completo', 'confidential', true, 'name', 'redact', 'Consentimento - Art. 7, I LGPD'),
    ('dim_pessoas', 'email', 'confidential', true, 'email', 'mask_email', 'Consentimento - Art. 7, I LGPD'),
    ('dim_pessoas', 'linkedin_url', 'internal', true, 'social', 'redact', 'Dado publicamente disponivel - Art. 7, X LGPD'),
    -- audit_logs columns (self-referential compliance)
    ('audit_logs', 'user_email', 'confidential', true, 'email', 'mask_email', 'Interesse legitimo - Art. 7, IX LGPD'),
    ('audit_logs', 'ip_address', 'confidential', true, 'address', 'hash', 'Interesse legitimo - Art. 7, IX LGPD')
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ============================================================================
-- FUNCTION: get_pii_columns(table_name)
-- Purpose: Returns all PII columns for a given table (useful for anonymization jobs)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_pii_columns(p_table_name TEXT)
RETURNS TABLE(column_name TEXT, pii_type TEXT, anonymization_rule TEXT) AS $$
BEGIN
    RETURN QUERY
    SELECT dc.column_name, dc.pii_type, dc.anonymization_rule
    FROM data_classification dc
    WHERE dc.table_name = p_table_name
      AND dc.contains_pii = true
    ORDER BY dc.column_name;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_pii_columns(TEXT) IS 'Returns all PII columns and their anonymization rules for a given table - used by data export and retention jobs';
