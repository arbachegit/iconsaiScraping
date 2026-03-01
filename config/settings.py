"""
IconsAI Scraping v2.0 - Settings
Configuracoes centralizadas do sistema
Business Intelligence Brasil
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuracoes do IconsAI Scraping v2.0"""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ===========================================
    # Environment
    # ===========================================
    environment: str = "development"
    debug: bool = False

    # ===========================================
    # APIs de Dados Brasileiros
    # ===========================================

    # BrasilAPI - Dados públicos (CNPJ, CEP, etc)
    brasil_api_url: str = "https://brasilapi.com.br/api"

    # ===========================================
    # APIs de Busca
    # ===========================================

    # Serper.dev - Google Search
    serper_api_key: str = ""
    serper_base_url: str = "https://google.serper.dev"
    serper_rate_limit: int = 100

    # Tavily - AI Search & News
    tavily_api_key: str = ""
    tavily_base_url: str = "https://api.tavily.com"
    tavily_rate_limit: int = 50

    # ===========================================
    # APIs de AI/Research
    # ===========================================

    # Perplexity - AI Research
    perplexity_api_key: str = ""
    perplexity_base_url: str = "https://api.perplexity.ai"
    perplexity_rate_limit: int = 50

    # Anthropic Claude - AI Analysis
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-20250514"

    # OpenAI - GPT Models (fallback for agent)
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

    # ===========================================
    # APIs de Dados B2B
    # ===========================================

    # Apollo.io - LinkedIn & Contatos
    apollo_api_key: str = ""
    apollo_base_url: str = "https://api.apollo.io/v1"
    apollo_rate_limit: int = 100

    # CNPJá - Regime Tributário
    cnpja_api_key: str = ""
    cnpja_base_url: str = "https://api.cnpja.com"

    # ===========================================
    # Brasil Data Hub (Dados Geográficos)
    # ===========================================

    # Supabase do projeto brasil-data-hub (geo_municipios)
    brasil_data_hub_url: str = ""
    brasil_data_hub_key: str = ""

    # ===========================================
    # Scheduler
    # ===========================================

    scheduler_enabled: bool = False
    scheduler_hour: int = 2
    scheduler_minute: int = 0

    # ===========================================
    # Banco de Dados
    # ===========================================

    # Supabase - Principal (IconsAI Scraping)
    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_anon_key: str = ""

    # Supabase - Fiscal Brasil (Dados Municipais)
    # https://supabase.com/dashboard/project/tijadrwimhxlggzxuwna
    fiscal_supabase_url: str = ""
    fiscal_supabase_key: str = ""

    # Redis (opcional)
    redis_url: str = "redis://localhost:6379/0"

    # ===========================================
    # Rate Limiting & Cache
    # ===========================================

    rate_limit_period: int = 60
    cache_ttl: int = 3600
    cache_max_size: int = 1000

    # ===========================================
    # Logging
    # ===========================================

    log_level: str = "INFO"
    log_format: str = "json"

    # ===========================================
    # Autenticação API
    # ===========================================

    jwt_secret_key: str = ""  # REQUIRED: Set via JWT_SECRET_KEY env var
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 480
    refresh_token_expire_days: int = 7

    # ===========================================
    # Field Encryption (AES-256 Fernet)
    # ===========================================

    # Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    field_encryption_key: str = ""

    # ===========================================
    # Email (Resend)
    # ===========================================

    resend_api_key: str = ""
    email_from: str = "noreply@iconsai.ai"
    app_base_url: str = "https://scraping.iconsai.ai"

    # ===========================================
    # Twilio (Primary Messaging)
    # ===========================================

    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_whatsapp_from: str = ""  # whatsapp:+14155238886
    twilio_sms_from: str = ""  # +1234567890

    # ===========================================
    # Infobip (Fallback Messaging)
    # ===========================================

    infobip_base_url: str = ""
    infobip_api_key: str = ""
    infobip_whatsapp_from: str = ""
    infobip_sms_from: str = ""

    # ===========================================
    # Seed Admin
    # ===========================================

    seed_admin_email: str = "admin@iconsai.ai"
    seed_admin_password: str = ""
    seed_admin_name: str = "Super Admin"

    # ===========================================
    # CORS - Origens Permitidas
    # ===========================================

    # Lista de origens separadas por vírgula
    # Ex: "http://localhost:3000,https://app.iconsai.dev"
    allowed_origins: str = (
        "http://localhost:3000,http://localhost:5173,http://localhost:8000"
    )

    # ===========================================
    # Web Scraping
    # ===========================================

    playwright_headless: bool = True
    playwright_timeout: int = 30000
    user_agent: str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    # ===========================================
    # Propriedades Computadas
    # ===========================================

    @property
    def is_production(self) -> bool:
        """Verifica se está em produção"""
        return self.environment == "production"

    @property
    def is_development(self) -> bool:
        """Verifica se está em desenvolvimento"""
        return self.environment == "development"

    @property
    def has_serper(self) -> bool:
        """Verifica se Serper está configurado"""
        return bool(self.serper_api_key)

    @property
    def has_tavily(self) -> bool:
        """Verifica se Tavily está configurado"""
        return bool(self.tavily_api_key)

    @property
    def has_perplexity(self) -> bool:
        """Verifica se Perplexity está configurado"""
        return bool(self.perplexity_api_key)

    @property
    def has_apollo(self) -> bool:
        """Verifica se Apollo está configurado"""
        return bool(self.apollo_api_key)

    @property
    def has_anthropic(self) -> bool:
        """Verifica se Anthropic está configurado"""
        return bool(self.anthropic_api_key)

    @property
    def has_openai(self) -> bool:
        """Verifica se OpenAI está configurado"""
        return bool(self.openai_api_key)

    @property
    def has_supabase(self) -> bool:
        """Verifica se Supabase está configurado"""
        return bool(self.supabase_url and self.supabase_service_key)

    @property
    def has_fiscal_supabase(self) -> bool:
        """Verifica se Supabase Fiscal está configurado"""
        return bool(self.fiscal_supabase_url and self.fiscal_supabase_key)

    @property
    def has_brasil_data_hub(self) -> bool:
        """Verifica se Brasil Data Hub está configurado"""
        return bool(self.brasil_data_hub_url and self.brasil_data_hub_key)

    @property
    def has_cnpja(self) -> bool:
        """Verifica se CNPJá está configurado"""
        return bool(self.cnpja_api_key)

    @property
    def has_twilio(self) -> bool:
        """Verifica se Twilio está configurado"""
        return bool(self.twilio_account_sid and self.twilio_auth_token)

    @property
    def has_infobip(self) -> bool:
        """Verifica se Infobip está configurado"""
        return bool(self.infobip_base_url and self.infobip_api_key)

    @property
    def parsed_allowed_origins(self) -> list:
        """Retorna lista de origens permitidas para CORS"""
        if not self.allowed_origins:
            return ["http://localhost:3000"]
        return [
            origin.strip()
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        ]


@lru_cache()
def get_settings() -> Settings:
    """Retorna singleton das configuracoes"""
    return Settings()


# Alias para uso direto
settings = get_settings()
