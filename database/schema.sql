-- ===========================================
-- IconsAI Scraping - Database Schema
-- ===========================================

-- Usuarios (Level 1: is_admin BOOLEAN, sem role)
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
    permissions TEXT[] DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Pesquisas de Empresas
CREATE TABLE IF NOT EXISTS empresa_searches (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    search_type VARCHAR(50) NOT NULL, -- 'name', 'website', 'linkedin'
    search_query JSONB NOT NULL,
    results_count INTEGER DEFAULT 0,
    results JSONB,
    credits_used INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Pesquisas de LinkedIn
CREATE TABLE IF NOT EXISTS linkedin_searches (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    search_type VARCHAR(50) NOT NULL, -- 'profile', 'company', 'employees'
    search_query JSONB NOT NULL,
    results_count INTEGER DEFAULT 0,
    results JSONB,
    credits_used INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Scrapes realizados
CREATE TABLE IF NOT EXISTS scrapes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    url VARCHAR(2048) NOT NULL,
    scrape_type VARCHAR(50) NOT NULL, -- 'page', 'crawl', 'map', 'extract'
    options JSONB,
    content_length INTEGER,
    result JSONB,
    credits_used INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Logs de API
CREATE TABLE IF NOT EXISTS api_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    endpoint VARCHAR(255) NOT NULL,
    method VARCHAR(10) NOT NULL,
    request_body JSONB,
    response_status INTEGER,
    response_time_ms INTEGER,
    error_message TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creditos do usuario
CREATE TABLE IF NOT EXISTS user_credits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) UNIQUE,
    total_credits INTEGER DEFAULT 1000,
    used_credits INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indices para performance
CREATE INDEX IF NOT EXISTS idx_empresa_searches_user ON empresa_searches(user_id);
CREATE INDEX IF NOT EXISTS idx_empresa_searches_created ON empresa_searches(created_at);
CREATE INDEX IF NOT EXISTS idx_linkedin_searches_user ON linkedin_searches(user_id);
CREATE INDEX IF NOT EXISTS idx_scrapes_user ON scrapes(user_id);
CREATE INDEX IF NOT EXISTS idx_scrapes_url ON scrapes(url);
CREATE INDEX IF NOT EXISTS idx_api_logs_user ON api_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at);

-- Usuario admin padrao (Level 1: is_admin = true, sem role)
-- Seed real e feito via api/seed.py com env vars
INSERT INTO users (email, password_hash, name, is_admin, is_active, is_verified)
VALUES ('admin@iconsai.ai', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.4qtOxwOT3cWvGi', 'Admin', true, true, true)
ON CONFLICT (email) DO NOTHING;

-- Creditos iniciais para admin
INSERT INTO user_credits (user_id, total_credits)
SELECT id, 10000 FROM users WHERE email = 'admin@iconsai.ai'
ON CONFLICT (user_id) DO NOTHING;

-- ===========================================
-- Fontes de Dados - Rastreabilidade (OBRIGATÓRIO)
-- Conforme CLAUDE.md: ALWAYS registrar fontes de dados
-- ===========================================

CREATE TABLE IF NOT EXISTS fontes_dados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identificação
    nome VARCHAR(255) NOT NULL,
    categoria VARCHAR(50) NOT NULL,  -- 'api', 'scraping', 'manual', 'fiscal'

    -- Origem
    fonte_primaria VARCHAR(255) NOT NULL,  -- Ex: "Serper.dev", "BrasilAPI"
    url TEXT NOT NULL,
    documentacao_url TEXT,

    -- Rastreamento
    data_primeira_coleta TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_ultima_atualizacao TIMESTAMP,
    periodicidade VARCHAR(50),  -- 'tempo_real', 'diario', 'sob_demanda'

    -- Metadados
    formato VARCHAR(50) DEFAULT 'JSON',  -- 'JSON', 'HTML', 'XML', 'CSV'
    autenticacao_requerida BOOLEAN DEFAULT true,
    api_key_necessaria BOOLEAN DEFAULT true,

    -- Qualidade
    confiabilidade VARCHAR(20) DEFAULT 'alta',  -- 'alta', 'media', 'baixa'
    cobertura TEXT,  -- Ex: "empresas brasileiras", "CNPJs"
    observacoes TEXT,

    -- Audit
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    UNIQUE(nome, categoria)
);

-- Índices para fontes_dados
CREATE INDEX IF NOT EXISTS idx_fontes_categoria ON fontes_dados(categoria);
CREATE INDEX IF NOT EXISTS idx_fontes_fonte ON fontes_dados(fonte_primaria);
CREATE INDEX IF NOT EXISTS idx_fontes_confiabilidade ON fontes_dados(confiabilidade);

-- Inserir fontes de dados usadas no projeto
INSERT INTO fontes_dados (nome, categoria, fonte_primaria, url, documentacao_url, formato, autenticacao_requerida, api_key_necessaria, confiabilidade, cobertura, periodicidade)
VALUES
    ('BrasilAPI - CNPJ', 'api', 'BrasilAPI', 'https://brasilapi.com.br/api/cnpj/v1', 'https://brasilapi.com.br/docs', 'JSON', false, false, 'alta', 'CNPJs de empresas brasileiras', 'tempo_real'),
    ('BrasilAPI - CEP', 'api', 'BrasilAPI', 'https://brasilapi.com.br/api/cep/v2', 'https://brasilapi.com.br/docs', 'JSON', false, false, 'alta', 'CEPs brasileiros', 'tempo_real'),
    ('BrasilAPI - Bancos', 'api', 'BrasilAPI', 'https://brasilapi.com.br/api/banks/v1', 'https://brasilapi.com.br/docs', 'JSON', false, false, 'alta', 'Instituições financeiras brasileiras', 'sob_demanda'),
    ('Serper - Google Search', 'api', 'Serper.dev', 'https://google.serper.dev/search', 'https://serper.dev/docs', 'JSON', true, true, 'alta', 'Resultados de busca Google', 'tempo_real'),
    ('Serper - Google News', 'api', 'Serper.dev', 'https://google.serper.dev/news', 'https://serper.dev/docs', 'JSON', true, true, 'alta', 'Notícias via Google News', 'tempo_real'),
    ('Serper - Google Images', 'api', 'Serper.dev', 'https://google.serper.dev/images', 'https://serper.dev/docs', 'JSON', true, true, 'alta', 'Imagens via Google Images', 'tempo_real'),
    ('Tavily - AI Search', 'api', 'Tavily', 'https://api.tavily.com/search', 'https://docs.tavily.com', 'JSON', true, true, 'alta', 'Busca com contexto AI', 'tempo_real'),
    ('Apollo - People Search', 'api', 'Apollo.io', 'https://api.apollo.io/v1/mixed_people/search', 'https://apolloio.github.io/apollo-api-docs', 'JSON', true, true, 'media', 'Profissionais e contatos B2B', 'tempo_real'),
    ('Apollo - Organizations', 'api', 'Apollo.io', 'https://api.apollo.io/v1/mixed_companies/search', 'https://apolloio.github.io/apollo-api-docs', 'JSON', true, true, 'media', 'Empresas e organizações B2B', 'tempo_real'),
    ('Perplexity - Research', 'api', 'Perplexity AI', 'https://api.perplexity.ai/chat/completions', 'https://docs.perplexity.ai', 'JSON', true, true, 'alta', 'Pesquisa com AI avançada', 'tempo_real'),
    ('Anthropic - Claude', 'api', 'Anthropic', 'https://api.anthropic.com/v1/messages', 'https://docs.anthropic.com', 'JSON', true, true, 'alta', 'Análise e geração de texto com AI', 'tempo_real')
ON CONFLICT (nome, categoria) DO NOTHING;
